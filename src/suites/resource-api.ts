/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Resource API.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import {
  collectionUrl,
  resourceMetaUrl,
  resourcePolicyUrl,
  resourceUrl as resourceUrlOf,
  rootCapabilityId,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import { assertResourceWriteResponse, capabilityActionFor } from '../helpers.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  /** Whether the server parses multipart uploads, once probed. */
  multipart?: boolean
}

/**
 * The container URL of the suite's `credentials` Collection.
 *
 * @param alice {any}   the suite's root actor
 * @returns {string}
 */
function credentialsUrl(alice: any): string {
  return collectionUrl({
    spaceUrl: alice.space1.url,
    collectionId: 'credentials'
  })
}

/**
 * The URL of a Resource in the suite's `credentials` Collection.
 *
 * @param alice {any}   the suite's root actor
 * @param resourceId {string}
 * @returns {string}
 */
function credentialUrl(alice: any, resourceId: string): string {
  return resourceUrlOf({
    spaceUrl: alice.space1.url,
    collectionId: 'credentials',
    resourceId
  })
}

/**
 * A Resource URL in a Space that does not exist, for the not-found cases.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @returns {string}
 */
function missingResourceUrl({
  serverUrl,
  spaceId
}: {
  serverUrl: string
  spaceId: string
}): string {
  return resourceUrlOf({
    spaceUrl: spaceUrlById({ baseServerUrl: serverUrl, spaceId }),
    collectionId: 'unknown-collection',
    resourceId: 'unknown-resource'
  })
}

/**
 * Signs and sends a raw `multipart/form-data` POST to a Collection container.
 * A well-behaved client never sends a malformed multipart body, so the request
 * is assembled by hand: the exact body bytes are both digested by
 * `signCapabilityInvocation` (Request Body Integrity) and sent verbatim over
 * `fetch`, so the server's recomputed digest matches.
 *
 * @param options {object}
 * @param options.url {string}   the Collection container URL (trailing slash)
 * @param options.body {Uint8Array}   the exact multipart body bytes to send
 * @param options.boundary {string}   the multipart boundary token
 * @param options.invocationSigner {any}   the root controller's signer
 * @returns {Promise<Response>}
 */
async function postMultipart({
  url,
  body,
  boundary,
  invocationSigner
}: {
  url: string
  body: Uint8Array<ArrayBuffer>
  boundary: string
  invocationSigner: any
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'POST',
    headers: {
      date: new Date().toUTCString(),
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    body,
    invocationSigner,
    capabilityAction: 'POST'
  })
  // Wrap in a Blob so the exact same bytes travel over `fetch` (the digest was
  // computed over `body`); the explicit `content-type` header still governs.
  return fetch(url, {
    method: 'POST',
    headers: signatureHeaders as Record<string, string>,
    body: new Blob([body])
  })
}

/**
 * Assembles a `multipart/form-data` body from the given parts, each either a
 * plain form field or a file part, using the shared boundary token.
 *
 * @param options {object}
 * @param options.boundary {string}   the multipart boundary token
 * @param options.parts {Array<object>}   the ordered parts to encode
 * @returns {Uint8Array}
 */
function buildMultipartBody({
  boundary,
  parts
}: {
  boundary: string
  parts: Array<{
    name: string
    filename?: string
    contentType?: string
    value: string
  }>
}): Uint8Array<ArrayBuffer> {
  let text = ''
  for (const part of parts) {
    text += `--${boundary}\r\n`
    if (part.filename !== undefined) {
      text +=
        `Content-Disposition: form-data; name="${part.name}"; ` +
        `filename="${part.filename}"\r\n`
      text += `Content-Type: ${part.contentType ?? 'text/plain'}\r\n`
    } else {
      text += `Content-Disposition: form-data; name="${part.name}"\r\n`
    }
    text += `\r\n${part.value}\r\n`
  }
  text += `--${boundary}--\r\n`
  return new TextEncoder().encode(text)
}

/**
 * Whether the server parses `multipart/form-data` uploads. Support is
 * OPTIONAL, and a server without it stores the body as opaque bytes under its
 * `multipart/form-data` content type. So the probe uploads one valid file
 * part and reads back the stored content type. A type other than
 * `multipart/form-data` means the server took the file part's own type, so it
 * parsed the upload. The probe Resource is deleted afterwards, and the answer
 * is cached on the suite state.
 *
 * @param options {object}
 * @param options.state {State}
 * @param options.url {string}   the Collection container URL
 * @returns {Promise<boolean>}
 */
async function multipartSupported({
  state,
  url
}: {
  state: State
  url: string
}): Promise<boolean> {
  if (state.multipart !== undefined) {
    return state.multipart
  }
  const boundary = '----wasconf-probe'
  const response = await postMultipart({
    url,
    body: buildMultipartBody({
      boundary,
      parts: [
        {
          name: 'file',
          filename: 'probe.txt',
          contentType: 'text/plain',
          value: 'multipart probe'
        }
      ]
    }),
    boundary,
    invocationSigner: state.alice.rootClient.invocationSigner
  })
  if (response.status === 415 || response.status === 501) {
    state.multipart = false
    return false
  }
  assert.ok(
    response.ok,
    'a valid single-file multipart upload must be stored (parsed, or as ' +
      `opaque bytes), got ${response.status}`
  )
  const location = response.headers.get('location')
  assert.ok(location, 'expected a Location header on the probe upload')
  const storedUrl = new URL(location, url).toString()
  let supported: boolean
  try {
    const head = await state.alice.rootClient.request({
      url: storedUrl,
      method: 'HEAD',
      action: capabilityActionFor('HEAD')
    })
    const contentType: string = head.headers.get('content-type') ?? ''
    supported = !/^multipart\/form-data/i.test(contentType)
  } finally {
    try {
      await state.alice.rootClient.request({
        url: storedUrl,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup; teardown deletes the Space */
    }
  }
  state.multipart = supported
  return supported
}

export const resourceApi: Suite<State> = {
  id: 'resource-api',
  name: 'Resource API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    const spaceId = ctx.generateId()
    alice.space1 = {
      id: spaceId,
      url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // Pre-create the credentials collection so resource tests can POST/PUT into it
    await alice.rootClient.request({
      url: alice.space1.url,
      method: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    return { alice, bob }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: alice.space1.url,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'resource.anonymous-read-404',
      name: 'GET a resource with no auth headers falls through to policy and 404s (no public policy)',
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async ctx => {
        const { serverUrl } = ctx
        // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
        // and is denied as 404 (no-leak) when no access-control policy grants it.
        const response = await fetch(
          missingResourceUrl({ serverUrl, spaceId: 'any-space-id' }),
          { method: 'GET' }
        )
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'resource.read-missing-404',
      name: 'GET /space/:spaceId/:collectionId/:resourceId should 404 error on not found space id',
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const url = missingResourceUrl({
          serverUrl,
          spaceId: 'space-id-that-does-not-exist'
        })
        let expectedError: any
        try {
          await alice.rootClient.request({ url, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        assert.equal(expectedError.response.status, 404)
      }
    },
    {
      id: 'resource.post-get',
      name: '[root] POST and GET Resource with proper authorization',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const body = {
          id: 'sample-resource',
          name: 'Sample Verifiable Credential'
        }
        const response = await alice.rootClient.request({
          url: credentialsUrl(alice),
          method: 'POST',
          action: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        assert.equal(response.data['content-type'], 'application/json')
        assert.match(response.headers.get('content-type'), /application\/json/)

        // `Location` may be absolute or relative; it is compared after
        // resolving it against the request URL.
        const resourceUrl = new URL(
          response.headers.get('location'),
          credentialsUrl(alice)
        ).toString()
        assert.ok(resourceUrl.startsWith(credentialsUrl(alice)))

        const fetchResourceResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)
        assert.match(
          fetchResourceResponse.headers.get('content-type'),
          /application\/json/
        )
        assert.equal(
          fetchResourceResponse.data.name,
          'Sample Verifiable Credential'
        )
      }
    },
    {
      id: 'resource.post-get-non-json',
      name: '[root] POST and GET a non-JSON resource',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation',
        'https://w3id.org/pws#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
        const response = await alice.rootClient.request({
          url: credentialsUrl(alice),
          method: 'POST',
          body
        })
        assert.equal(response.status, 201)

        const createdUrl = new URL(
          response.headers.get('location'),
          credentialsUrl(alice)
        ).toString()
        const fetchResourceResponse = await alice.rootClient.request({
          url: createdUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)
        const responseBody = await fetchResourceResponse.text()
        assert.equal(responseBody, 'line 1\nline2\n')
      }
    },
    {
      id: 'resource.put-get',
      name: '[root] PUT and GET Resource',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const resourceId = 'put-resource'
        const resourceUrl = credentialUrl(alice, resourceId)
        const body = { id: resourceId, name: 'PUT Resource Test' }

        const putResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: body
        })
        assertResourceWriteResponse({ response: putResponse, created: true })

        const getResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.data.name, 'PUT Resource Test')
      }
    },
    {
      id: 'resource.put-missing-collection-404',
      name: '[root] PUT Resource to non-existent collection should 404',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const resourceUrl = resourceUrlOf({
          spaceUrl: alice.space1.url,
          collectionId: 'collection-does-not-exist',
          resourceId: 'some-resource'
        })
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl,
            method: 'PUT',
            json: { name: 'test' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.equal(expectedError.response.status, 404)
      }
    },
    {
      id: 'resource.put-upsert',
      name: '[root] PUT Resource should update existing resource (upsert)',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const resourceId = 'upsert-resource'
        const resourceUrl = credentialUrl(alice, resourceId)

        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Original Name' }
        })

        const secondPut = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Updated Name' }
        })
        assertResourceWriteResponse({ response: secondPut, created: false })

        const getResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.data.name, 'Updated Name')
      }
    },
    {
      id: 'resource.cross-user-read-404',
      name: "[root] Bob should not be able to GET Alice's resources",
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async (ctx, state) => {
        const { alice, bob } = state
        const body = {
          id: 'alice-private-resource',
          name: 'Alice Private Resource'
        }
        const postResponse = await alice.rootClient.request({
          url: credentialsUrl(alice),
          method: 'POST',
          json: body
        })
        assert.equal(postResponse.status, 201)
        const resourceUrl = new URL(
          postResponse.headers.get('location'),
          credentialsUrl(alice)
        ).toString()

        let expectedError: any
        try {
          await bob.rootClient.request({ url: resourceUrl, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        // Bob gets a 404, not a 403, to avoid revealing the resource's existence
        assert.equal(expectedError.response.status, 404)

        await alice.rootClient.request({ url: resourceUrl, method: 'DELETE' })
      }
    },
    {
      id: 'resource.meta-get-or-skip',
      name: '[root] GET Resource Metadata (/meta), or skip if unimplemented',
      specRefs: ['https://w3id.org/pws#read-resource-metadata-operation'],
      run: async (ctx, state) => {
        const { generateId } = ctx
        const { alice } = state
        // Resource Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Metadata Resource' }
        })

        const metaUrl = resourceMetaUrl({
          spaceUrl: alice.space1.url,
          collectionId: 'credentials',
          resourceId
        })
        let response: any
        try {
          response = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
        } catch (err: any) {
          if (err.response?.status === 501) {
            // Optional endpoint not implemented -- pass with skip.
            ctx.skip('Resource Metadata (/meta) not implemented (501)')
          }
          throw err
        }

        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(response.data.contentType, 'application/json')
        assert.ok(
          Number.isInteger(response.data.size) && response.data.size > 0,
          'size should be a positive integer'
        )

        // An anonymous (unsigned) meta read must not leak existence: 404.
        const anonResponse = await fetch(metaUrl)
        assert.equal(anonResponse.status, 404)
      }
    },
    {
      id: 'head.binary-resource',
      name: '[root] HEAD a binary resource returns its content-type + content-length, no body',
      group: 'HEAD Resource',
      specRefs: [
        'https://w3id.org/pws#read-resource-operation',
        'https://w3id.org/pws#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // 'line 1\nline2\n' is exactly 13 bytes.
        const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
        const postResponse = await alice.rootClient.request({
          url: credentialsUrl(alice),
          method: 'POST',
          body
        })
        assert.equal(postResponse.status, 201)
        const resourceUrl = new URL(
          postResponse.headers.get('location'),
          credentialsUrl(alice)
        ).toString()

        const headResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'HEAD',
          action: capabilityActionFor('HEAD')
        })
        assert.equal(headResponse.status, 200)
        assert.match(headResponse.headers.get('content-type'), /text\/plain/)
        assert.equal(headResponse.headers.get('content-length'), '13')
        // HEAD carries no body.
        assert.equal(await headResponse.text(), '')
      }
    },
    {
      id: 'head.delegated-get-grant',
      name: '[delegated] a GET-only grant authorizes a HEAD signed with the GET action',
      group: 'HEAD Resource',
      specRefs: ['https://w3id.org/pws/authz-profile#get-action'],
      run: async (ctx, state) => {
        const { generateId, actors } = ctx
        const { alice } = state
        const { aliceDelegatedApp } = actors
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        const putResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          // Plain text: the client would parse a JSON HEAD body and fail on it.
          body: new Blob(['line 1\nline2\n'], { type: 'text/plain' })
        })
        assert.ok(putResponse.ok, `PUT failed with ${putResponse.status}`)

        // Rooted at the Space, as the Space's root capability id is minted
        // from its canonical URL.
        const capability = await alice.rootClient.delegate({
          capability: rootCapabilityId(alice.space1.url),
          allowedActions: ['GET'],
          invocationTarget: resourceUrl,
          controller: aliceDelegatedApp.did
        })
        const appClient = ctx.zcapClient({ signer: aliceDelegatedApp.signer })

        const getResponse = await appClient.request({
          url: resourceUrl,
          method: 'GET',
          action: capabilityActionFor('GET'),
          capability
        })
        assert.equal(getResponse.status, 200)
        const getBytes = await getResponse.arrayBuffer()

        const headResponse = await appClient.request({
          url: resourceUrl,
          method: 'HEAD',
          action: capabilityActionFor('HEAD'),
          capability
        })
        assert.equal(headResponse.status, 200)
        assert.equal(
          headResponse.headers.get('content-type'),
          getResponse.headers.get('content-type')
        )
        assert.equal(
          headResponse.headers.get('content-length'),
          String(getBytes.byteLength)
        )
        const getEtag = getResponse.headers.get('etag')
        if (getEtag !== null) {
          assert.equal(headResponse.headers.get('etag'), getEtag)
        }
        // HEAD carries no body.
        assert.equal(await headResponse.text(), '')
      }
    },
    {
      id: 'head.private-denied-404',
      name: 'anonymous HEAD of a private resource is denied (404, no leak)',
      group: 'HEAD Resource',
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async (ctx, state) => {
        const { generateId } = ctx
        const { alice } = state
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Private HEAD Resource' }
        })

        const response = await fetch(resourceUrl, { method: 'HEAD' })
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'head.public-matches-get',
      name: 'anonymous HEAD of a PublicCanRead resource returns headers matching a GET',
      group: 'HEAD Resource',
      specRefs: [
        'https://w3id.org/pws#read-resource-operation',
        'https://w3id.org/pws#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { generateId } = ctx
        const { alice } = state
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Public HEAD Resource' }
        })
        // Grant public read at the resource level.
        await alice.rootClient.request({
          url: resourcePolicyUrl({
            spaceUrl: alice.space1.url,
            collectionId: 'credentials',
            resourceId
          }),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })

        // The HEAD Content-Type/Content-Length must match what a GET returns
        // (spec "Content Types and Representations": both correspond to the
        // Metadata `contentType`/`size`).
        const getResponse = await fetch(resourceUrl)
        assert.equal(getResponse.status, 200)
        const getBytes = await getResponse.arrayBuffer()

        const headResponse = await fetch(resourceUrl, {
          method: 'HEAD'
        })
        assert.equal(headResponse.status, 200)
        assert.equal(
          headResponse.headers.get('content-type'),
          getResponse.headers.get('content-type')
        )
        assert.equal(
          headResponse.headers.get('content-length'),
          String(getBytes.byteLength)
        )
        assert.equal(await headResponse.text(), '')

        // Cleanup: revoke the resource policy.
        await alice.rootClient.request({
          url: resourcePolicyUrl({
            spaceUrl: alice.space1.url,
            collectionId: 'credentials',
            resourceId
          }),
          method: 'DELETE'
        })
      }
    },
    {
      id: 'resource.post-delete',
      name: '[root] POST and DELETE Resource with proper authorization',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation',
        'https://w3id.org/pws#delete-resource-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const body = { id: 'sample-resource-to-delete', name: 'Sample Delete' }
        const response = await alice.rootClient.request({
          url: credentialsUrl(alice),
          method: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        assert.equal(response.data['content-type'], 'application/json')
        assert.match(response.headers.get('content-type'), /application\/json/)

        // `Location` may be absolute or relative; it is compared after
        // resolving it against the request URL.
        const resourceUrl = new URL(
          response.headers.get('location'),
          credentialsUrl(alice)
        ).toString()
        assert.ok(resourceUrl.startsWith(credentialsUrl(alice)))

        const fetchResourceResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET'
        })
        assert.equal(fetchResourceResponse.status, 200)

        const deleteResponse = await alice.rootClient.request({
          url: resourceUrl,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({ url: resourceUrl, method: 'GET' })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'resource.multipart-zero-file-parts-400',
      name:
        '[root] a multipart upload with no file part is rejected with 400 ' +
        'invalid-request-body',
      specRefs: [
        'https://w3id.org/pws#content-types-and-representations',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // Multipart upload support is OPTIONAL; where offered, a write targets a
        // single Resource, so a body with no file part MUST be rejected. A
        // server that does not parse multipart uploads is treated as a skip.
        const url = credentialsUrl(alice)
        if (!(await multipartSupported({ state, url }))) {
          ctx.skip('server does not parse multipart uploads')
        }
        const boundary = '----wasconf-zero-parts'
        const body = buildMultipartBody({
          boundary,
          parts: [{ name: 'note', value: 'no file here' }]
        })
        const response = await postMultipart({
          url,
          body,
          boundary,
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(response.status, 400)
        const problem: any = await response.json()
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-request-body')
      }
    },
    {
      id: 'resource.multipart-two-file-parts-400',
      name:
        '[root] a multipart upload with two file parts is rejected with 400 ' +
        'invalid-request-body',
      specRefs: [
        'https://w3id.org/pws#content-types-and-representations',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const url = credentialsUrl(alice)
        if (!(await multipartSupported({ state, url }))) {
          ctx.skip('server does not parse multipart uploads')
        }
        const boundary = '----wasconf-two-parts'
        const body = buildMultipartBody({
          boundary,
          parts: [
            {
              name: 'file1',
              filename: 'a.txt',
              contentType: 'text/plain',
              value: 'first file'
            },
            {
              name: 'file2',
              filename: 'b.txt',
              contentType: 'text/plain',
              value: 'second file'
            }
          ]
        })
        const response = await postMultipart({
          url,
          body,
          boundary,
          invocationSigner: alice.rootClient.invocationSigner
        })
        assert.equal(response.status, 400)
        const problem: any = await response.json()
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-request-body')
      }
    },
    {
      id: 'resource.read-ignores-unacceptable-accept',
      name:
        '[root] GET a JSON Resource with an unsatisfiable Accept returns 200, ' +
        'never 406',
      specRefs: ['https://w3id.org/pws#content-types-and-representations'],
      run: async (ctx, state) => {
        const { generateId } = ctx
        const { alice } = state
        // A Resource has exactly one stored representation; the Accept header is
        // advisory. A server MUST NOT reject a read for lack of an acceptable
        // representation -- the stored representation is always the answer.
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Accept-Ignored Resource' }
        })

        const response = await alice.rootClient.request({
          url: resourceUrl,
          method: 'GET',
          headers: { accept: 'application/vnd.nonexistent' }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(response.data.name, 'Accept-Ignored Resource')
      }
    },
    {
      id: 'resource.putmeta-ignores-server-managed',
      name:
        '[root] PUT /meta ignores top-level contentType/size and applies only ' +
        'custom',
      specRefs: [
        'https://w3id.org/pws#update-resource-metadata-operation',
        'https://w3id.org/pws#resource-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { generateId } = ctx
        const { alice } = state
        // Resource Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const resourceId = generateId()
        const resourceUrl = credentialUrl(alice, resourceId)
        await alice.rootClient.request({
          url: resourceUrl,
          method: 'PUT',
          json: { id: resourceId, name: 'Metadata Resource' }
        })
        const metaUrl = resourceMetaUrl({
          spaceUrl: alice.space1.url,
          collectionId: 'credentials',
          resourceId
        })

        // Read the server-managed metadata first (skips if /meta is 501).
        let before: any
        try {
          before = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
        } catch (err: any) {
          if (err.response?.status === 501) {
            ctx.skip('Resource Metadata (/meta) not implemented (501)')
          }
          throw err
        }
        assert.equal(before.data.contentType, 'application/json')
        const managedSize = before.data.size
        assert.ok(Number.isInteger(managedSize) && managedSize > 0)

        // PUT /meta carrying bogus top-level server-managed props alongside
        // `custom`: only `custom` is applied; the rest MUST be ignored.
        const custom = { name: 'User Label', tags: { status: 'draft' } }
        const putResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { contentType: 'text/plain', size: 999999, custom }
        })
        assertResourceWriteResponse({
          response: putResponse,
          created: false,
          metaWrite: true
        })

        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.status, 200)
        // Server-managed properties are untouched by the write.
        assert.equal(after.data.contentType, 'application/json')
        assert.equal(after.data.size, managedSize)
        // The user-writable `custom` object was applied.
        assert.deepStrictEqual(after.data.custom, custom)
      }
    }
  ]
}
