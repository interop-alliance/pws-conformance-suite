/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collections API.
 */
import { spaceUrlById } from '@interop/was-client/paths'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import assert from '../harness/assert.js'
import { withoutCreatingStamp, withoutWriteStamp } from '../helpers.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
}

/**
 * Signs and sends a GET capability invocation against a (possibly
 * query-bearing) list URL, using a delegated capability -- the page-follow a
 * replicating consumer performs. The `next` URLs differ only in their query
 * string, which a list capability tolerates (the page selects within an
 * already-authorized target), so the same capability is reused for every page.
 *
 * @param options {object}
 * @param options.url {string}   the page URL to invoke against
 * @param options.capability {IZcap}   the delegated list capability
 * @param options.invocationSigner {ISigner}   the delegate's signer
 * @returns {Promise<Response>}
 */
async function getWithCapability({
  url,
  capability,
  invocationSigner
}: {
  url: string
  capability: IZcap
  invocationSigner: ISigner
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'GET',
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capability,
    capabilityAction: 'GET'
  })
  return fetch(url, {
    method: 'GET',
    headers: signatureHeaders as Record<string, string>
  })
}

/**
 * Sends a signed Collection Metadata request, translating a 501
 * `unsupported-operation` into a skip: Collection Metadata is an OPTIONAL
 * feature, so a server that does not implement it must not be failed for it.
 * Any other error is rethrown for the caller to assert on.
 *
 * @param options {object}
 * @param options.ctx {any}   the test context (for `ctx.skip`)
 * @param options.alice {any}   the suite's root actor
 * @param options.url {string}   the `/meta` URL
 * @param options.method {string}   'GET' or 'PUT'
 * @param [options.json] {object}   the request body, for a PUT
 * @param [options.headers] {object}   extra request headers (preconditions)
 * @returns {Promise<any>}
 */
async function metaRequestOrSkip({
  ctx,
  alice,
  url,
  method,
  json,
  headers
}: {
  ctx: any
  alice: any
  url: string
  method: string
  json?: object
  headers?: Record<string, string>
}): Promise<any> {
  try {
    return await alice.rootClient.request({
      url,
      method,
      action: method,
      ...(json !== undefined && { json }),
      ...(headers !== undefined && { headers })
    })
  } catch (err: any) {
    if (err.response?.status === 501) {
      ctx.skip('Collection Metadata (/meta) not implemented (501)')
    }
    throw err
  }
}

/**
 * Provisions a fresh Collection with a random id via a guarded (create-only)
 * `PUT` of its Metadata object -- the v0.5 create-by-id path, now that `PUT`
 * at the bare Collection URL is retired (405). Returns its container URL and
 * its `/meta` URL. Every Collection Metadata test works on its own
 * Collection, so the stamp sequence a test observes is its own.
 *
 * @param options {object}
 * @param options.ctx {any}   the test context (for `serverUrl` / `generateId` / `skip`)
 * @param options.alice {any}   the suite's root actor
 * @returns {Promise<{collectionUrl: string, metaUrl: string}>}
 */
async function freshCollection({
  ctx,
  alice
}: {
  ctx: any
  alice: any
}): Promise<{ collectionUrl: string; metaUrl: string }> {
  const collectionId = ctx.generateId()
  const collectionUrl = new URL(
    `/space/${alice.space1.id}/${collectionId}`,
    ctx.serverUrl
  ).toString()
  const metaUrl = `${collectionUrl}/meta`
  await metaRequestOrSkip({
    ctx,
    alice,
    url: metaUrl,
    method: 'PUT',
    json: { id: collectionId, name: 'Metadata Collection' }
  })
  return { collectionUrl, metaUrl }
}

export const collectionApi: Suite<State> = {
  id: 'collection-api',
  name: 'Collections API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
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
    return { alice }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'collection.create-unauthorized-401',
      name: 'POST /space/:spaceId/ should 401 error when no authorization headers',
      specRefs: [
        'https://w3id.org/pws#create-collection-add-collection-to-a-space-operation'
      ],
      run: async ctx => {
        const { serverUrl } = ctx
        const response = await fetch(
          new URL('/space/any-space-id/', serverUrl),
          {
            method: 'POST'
          }
        )
        assert.equal(response.status, 401)
        assert.match(
          response.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.create-missing-space-404',
      name: 'POST /space/:spaceId/ should 404 error on not found space id',
      specRefs: [
        'https://w3id.org/pws#create-collection-add-collection-to-a-space-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const spaceUrl = new URL(
          '/space/space-id-that-does-not-exist/',
          serverUrl
        ).toString()
        // A body is required so the request reaches the existence check
        // rather than failing body validation first.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl,
            method: 'POST',
            action: 'POST',
            json: { name: 'Probe Collection' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.equal(expectedError.response.status, 404)
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.create-post',
      name: '[root] create collection via POST',
      specRefs: [
        'https://w3id.org/pws#create-collection-add-collection-to-a-space-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        const body = { id: 'credentials', name: 'Verifiable Credentials' }
        const response = await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: body
        })
        assert.equal(response.status, 201)
        // The Collection's `url` is stamped in its canonical trailing-slash
        // (container) form, matching a subsequent Read Collection Metadata.
        // The echo is the full Collection Metadata object, so it also
        // carries `createdAt`, the write stamp, and `linkset`.
        const { createdAt, ...echo } = withoutCreatingStamp(
          withoutWriteStamp(withoutCreatedBy(response.data))
        )
        assert.ok(!Number.isNaN(Date.parse(createdAt as string)))
        assert.deepStrictEqual(echo, {
          id: 'credentials',
          name: 'Verifiable Credentials',
          type: ['Collection'],
          backend: { id: 'default' },
          url: `/space/${alice.space1.id}/credentials/`,
          linkset: `/space/${alice.space1.id}/credentials/linkset`
        })
        assert.match(response.headers.get('content-type'), /application\/json/)
        assert.equal(
          response.headers.get('location'),
          `${serverUrl}/space/${alice.space1.id}/${body.id}/`
        )
      }
    },
    {
      id: 'collection.create-post-id-conflict-409',
      name: '[root] POST with an existing collection id yields id-conflict (409)',
      specRefs: ['https://w3id.org/pws#id-conflict'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // 'credentials' was created by the POST test above.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: 'credentials', name: 'Replacement' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the duplicate-id POST to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#id-conflict'
        )
      }
    },
    {
      id: 'collection.list-items',
      name: '[root] list collection items via GET :collectionId/',
      specRefs: ['https://w3id.org/pws#list-collection-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/credentials/`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        const listResponse = response.data
        assert.equal(listResponse.id, 'credentials')
        // The listing envelope's own `url` carries the trailing slash (spec
        // "Reading This Document": a trailing slash marks a container).
        assert.equal(listResponse.url, `/space/${alice.space1.id}/credentials/`)
        assert.equal(listResponse.name, 'Verifiable Credentials')
        assert.deepStrictEqual(listResponse.type, ['Collection'])
        assert.equal(typeof listResponse.totalItems, 'number')
        assert.ok(Array.isArray(listResponse.items))
        assert.equal(listResponse.totalItems, listResponse.items.length)
      }
    },
    {
      id: 'collection.read-metadata',
      name: '[root] get the Collection Metadata object via GET :collectionId/meta',
      specRefs: [
        'https://w3id.org/pws#read-collection-metadata-operation',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        // v0.5 retires the bare-URL Collection description; reading a
        // Collection's description is now always a GET of `meta`.
        const response = await metaRequestOrSkip({
          ctx,
          alice,
          url: new URL(
            `/space/${alice.space1.id}/credentials/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        // `updatedAt` belongs to the write stamp, checked with the rest of it.
        const { createdAt, ...rest } = withoutCreatingStamp(
          withoutWriteStamp(withoutCreatedBy(response.data))
        )
        assert.ok(!Number.isNaN(Date.parse(createdAt as string)))
        assert.deepStrictEqual(rest, {
          id: 'credentials',
          name: 'Verifiable Credentials',
          type: ['Collection'],
          backend: { id: 'default' },
          url: `/space/${alice.space1.id}/credentials/`,
          linkset: `/space/${alice.space1.id}/credentials/linkset`
        })
      }
    },
    {
      id: 'collection.non-canonical-url-redirects',
      name:
        '[root] the non-canonical (no-slash) Collection URL 308s to the ' +
        'canonical (trailing-slash) form; the canonical form is not redirected',
      optional: true,
      specRefs: ['https://w3id.org/pws#reading-this-document'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const bareUrl = new URL(
          `/space/${alice.space1.id}/credentials`,
          serverUrl
        )
        const canonicalPath = `/space/${alice.space1.id}/credentials/`

        const redirected = await fetch(bareUrl, {
          method: 'GET',
          redirect: 'manual'
        })
        if (redirected.type === 'opaqueredirect') {
          ctx.skip(
            'redirect responses are opaque in this runtime (cross-origin fetch)'
          )
        }
        assert.equal(redirected.status, 308)
        const location = redirected.headers.get('location')
        assert.ok(location, 'expected a Location header on the redirect')
        assert.equal(new URL(location, serverUrl).pathname, canonicalPath)

        // The canonical form itself is never redirected -- whatever it
        // answers (200, 401, 404...) it is not a 308.
        const canonical = await fetch(new URL(canonicalPath, serverUrl), {
          method: 'GET',
          redirect: 'manual'
        })
        assert.notEqual(canonical.status, 308)
      }
    },
    {
      id: 'collection.put-container-405',
      name:
        '[root] PUT at the canonical Collection URL is 405 (PUT is not ' +
        'defined at the container)',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { name: 'Should Not Replace' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a PUT at the Collection container URL to be refused'
        )
        assert.equal(expectedError.response.status, 405)
        const allow = (expectedError.response.headers.get('allow') ?? '')
          .split(',')
          .map((method: string) => method.trim())
          .filter(Boolean)
        assert.ok(!allow.includes('PUT'), 'Allow must not include PUT')
        assert.match(
          expectedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.paginate-limit-next',
      name: '[root] paginates List Collection via ?limit and follows next (spec Pagination)',
      specRefs: [
        'https://w3id.org/pws#list-collection-operation',
        'https://w3id.org/pws#pagination'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // Fresh Collection seeded with > one page of Resources, inserted out of order
        // to prove the listing order is by id, not insertion.
        const collectionId = generateId()
        // WAS does not auto-create parent Collections, so provision it first
        // (create-by-id is a guarded `PUT` of its Metadata object).
        await metaRequestOrSkip({
          ctx,
          alice,
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: collectionId, name: 'Paginated Collection' }
        })
        const ids = ['g05', 'g01', 'g04', 'g02', 'g00', 'g03']
        for (const id of ids) {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/${collectionId}/${id}`,
              serverUrl
            ).toString(),
            method: 'PUT',
            json: { value: id }
          })
        }

        const seen: string[] = []
        let nextUrl: string | undefined = new URL(
          `/space/${alice.space1.id}/${collectionId}/?limit=2`,
          serverUrl
        ).toString()
        let pages = 0
        while (nextUrl) {
          const response: any = await alice.rootClient.request({
            url: nextUrl,
            method: 'GET'
          })
          assert.equal(response.status, 200)
          pages++
          assert.ok(response.data.items.length <= 2, 'page respects the limit')
          seen.push(...response.data.items.map((item: any) => item.id))
          // `next` is server-relative; follow it verbatim, resolved against serverUrl.
          nextUrl = response.data.next
            ? new URL(response.data.next, serverUrl).toString()
            : undefined
        }

        // 6 items at limit 2 -> 3 pages; the last omits `next` (end-of-list signal).
        assert.equal(pages, 3)
        assert.deepStrictEqual(seen, ['g00', 'g01', 'g02', 'g03', 'g04', 'g05'])
      }
    },
    {
      id: 'collection.malformed-cursor-400',
      name: '[root] a malformed cursor yields invalid-cursor (400)',
      specRefs: ['https://w3id.org/pws#invalid-cursor'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/credentials/?cursor=not-valid-%%%`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the malformed cursor to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-cursor'
        )
      }
    },
    {
      id: 'collection.create-delete-by-id',
      name: '[root] create and delete a collection by id',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#delete-collection-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const collectionId = 'new-collection'
        const collectionUrl = new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString()
        const metaUrl = `${collectionUrl}/meta`
        const body = { id: collectionId, name: 'New Collection' }

        const created = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: body
        })
        assert.equal(created.status, 201)

        const existResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(existResponse.status, 200)

        // Delete Collection is at the canonical (trailing-slash) container URL.
        const deleteResponse = await alice.rootClient.request({
          url: `${collectionUrl}/`,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({ url: metaUrl, method: 'GET' })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'collection.create-unknown-backend-409',
      name:
        '[root] creating a Collection naming an unregistered backend id is ' +
        'rejected with 409 unsupported-backend',
      specRefs: [
        'https://w3id.org/pws#collection-backend-selected',
        'https://w3id.org/pws#unsupported-backend'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        // A Collection's `backend.id` must name a backend in the Space's
        // available list; an unknown id is rejected rather than silently
        // defaulting.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: {
              id: generateId(),
              name: 'Bad Backend Collection',
              backend: { id: 'no-such-backend' }
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the unknown-backend create to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#unsupported-backend'
        )
      }
    },
    {
      id: 'collection.create-post-meta-reserved-id-409',
      name:
        '[root] creating a Collection with the reserved id `meta` via POST ' +
        'is rejected with 409 reserved-id',
      specRefs: [
        'https://w3id.org/pws#space-level-reserved-endpoints',
        'https://w3id.org/pws#reserved-id'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // `meta` occupies the Space Metadata object's own path
        // (`/space/{s}/meta`), so it is a reserved Collection id -- v0.5
        // widens the Space-level reserved-endpoint table to include it.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
            method: 'POST',
            action: 'POST',
            json: { id: 'meta', name: 'Reserved Meta Collection Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the `meta` Collection id to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#reserved-id'
        )
      }
    },
    {
      id: 'collection.paginate-delegated-no-redelegation',
      name:
        '[delegated] a single list capability reads every page; no per-page ' +
        're-delegation is required',
      specRefs: [
        'https://w3id.org/pws#pagination',
        'https://w3id.org/pws/authz-profile#root-capability'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        const aliceDelegatedApp = ctx.actors.aliceDelegatedApp
        // Seed a fresh Collection with more than one page of Resources.
        const collectionId = generateId()
        await metaRequestOrSkip({
          ctx,
          alice,
          url: new URL(
            `/space/${alice.space1.id}/${collectionId}/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          json: { id: collectionId, name: 'Delegated Paginated Collection' }
        })
        const ids = ['p04', 'p00', 'p03', 'p01', 'p05', 'p02']
        for (const id of ids) {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/${collectionId}/${id}`,
              serverUrl
            ).toString(),
            method: 'PUT',
            json: { value: id }
          })
        }

        // Alice delegates a read (GET) capability on the list target -- the
        // Collection container URL -- to her delegated app.
        const listTarget = new URL(
          `/space/${alice.space1.id}/${collectionId}/`,
          serverUrl
        ).toString()
        const zcap = await alice.was.grant({
          to: aliceDelegatedApp.did,
          actions: ['GET'],
          target: listTarget,
          spaceUrl: alice.space1.url
        })

        // The delegate follows `next` across all pages using that SAME
        // capability for every page; only `limit`/`cursor` in the query differ.
        const seen: string[] = []
        let nextUrl: string | undefined = new URL(
          `/space/${alice.space1.id}/${collectionId}/?limit=2`,
          serverUrl
        ).toString()
        let pages = 0
        while (nextUrl) {
          const response = await getWithCapability({
            url: nextUrl,
            capability: zcap,
            invocationSigner: aliceDelegatedApp.signer
          })
          assert.equal(
            response.status,
            200,
            `expected page ${pages + 1} to be authorized by the delegated ` +
              `capability, got ${response.status}`
          )
          const page: any = await response.json()
          pages++
          assert.ok(page.items.length <= 2, 'page respects the limit')
          seen.push(...page.items.map((item: any) => item.id))
          nextUrl = page.next
            ? new URL(page.next, serverUrl).toString()
            : undefined
        }

        assert.equal(pages, 3)
        assert.deepStrictEqual(seen.sort(), [
          'p00',
          'p01',
          'p02',
          'p03',
          'p04',
          'p05'
        ])
      }
    },
    {
      id: 'collection.meta-get-or-skip',
      name: '[root] GET Collection Metadata (/meta), or skip if unimplemented',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#read-collection-metadata-operation',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // Collection Metadata is OPTIONAL: a server that does not implement it
        // responds 501 `unsupported-operation`, which this test treats as a skip.
        const { metaUrl } = await freshCollection({ ctx, alice })
        const response = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        // The validator is the ETag, carried out of band. The retired
        // `metaVersion` counter is not a member of the Metadata body.
        assert.equal(response.data.metaVersion, undefined)

        // An anonymous (unsigned) meta read must not leak existence: the
        // Collection carries no public-read policy, so 404 problem+json.
        const anonResponse = await fetch(new URL(metaUrl))
        assert.equal(anonResponse.status, 404)
        assert.match(
          anonResponse.headers.get('content-type')!,
          /application\/problem\+json/
        )
      }
    },
    {
      id: 'collection.meta-put-get-roundtrip',
      name: '[root] PUT Collection Metadata sets `custom`, round-tripped by GET',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#read-collection-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const custom = { name: 'Trip Photos', tags: { app: 'gallery' } }
        const putResponse = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom }
        })
        assert.ok(
          putResponse.status === 204 || putResponse.status === 200,
          `expected a success status, got ${putResponse.status}`
        )
        // The write returns the new metadata validator so a client can chain a
        // conditional metadata write.
        const writtenEtag = putResponse.headers.get('etag')
        assert.ok(writtenEtag, 'expected an ETag on the metadata write')

        const getResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.equal(getResponse.headers.get('etag'), writtenEtag)
        assert.deepStrictEqual(getResponse.data.custom, custom)
        // Server-managed timestamps are recorded once metadata has been written.
        assert.ok(
          !Number.isNaN(Date.parse(getResponse.data.createdAt)),
          '`createdAt` should be a timestamp'
        )
        assert.ok(
          !Number.isNaN(Date.parse(getResponse.data.updatedAt)),
          '`updatedAt` should be a timestamp'
        )
      }
    },
    {
      id: 'collection.meta-put-full-replacement',
      name:
        '[root] PUT Collection Metadata is a full replacement; a body with no ' +
        '`custom` clears it',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const first = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Temporary', tags: { a: 'b' } } }
        })
        const firstEtag = first.headers.get('etag')

        const cleared = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: {}
        })
        assert.ok(
          cleared.status === 204 || cleared.status === 200,
          `expected a success status, got ${cleared.status}`
        )
        assert.notEqual(
          cleared.headers.get('etag'),
          firstEtag,
          'the metadata validator advances on every write'
        )

        const getResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        // Every user-writable property is gone (an absent `custom`, or an
        // empty one).
        assert.deepStrictEqual(getResponse.data.custom ?? {}, {})
      }
    },
    {
      id: 'collection.meta-put-ignores-server-managed',
      name:
        '[root] PUT Collection Metadata ignores server-managed top-level ' +
        'members (read-modify-write is safe)',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Before' } }
        })

        // Read the whole Metadata object, tweak `custom`, and PUT it back
        // unstripped -- with the server-managed members deliberately falsified.
        const before = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        const managedCreatedAt = before.data.createdAt
        const putResponse = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: {
            ...before.data,
            createdBy: 'did:key:zSomeoneElse',
            createdAt: '1999-01-01T00:00:00.000Z',
            custom: { name: 'After' }
          }
        })
        assert.ok(
          putResponse.status === 204 || putResponse.status === 200,
          `expected a success status, got ${putResponse.status}`
        )

        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.createdAt, managedCreatedAt)
        assert.notEqual(after.data.createdBy, 'did:key:zSomeoneElse')
        // Only the user-writable `custom` was applied.
        assert.deepStrictEqual(after.data.custom, { name: 'After' })
      }
    },
    {
      id: 'collection.meta-put-creates-missing-collection',
      name:
        '[root] PUT Collection Metadata on a nonexistent Collection creates ' +
        'it (201), the `Location` naming the Collection',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const collectionId = ctx.generateId()
        const collectionUrl = new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString()
        const metaUrl = `${collectionUrl}/meta`
        const response = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'Created via meta' } }
        })
        assert.equal(response.status, 201)
        // `Location` names the Collection created, in its canonical
        // trailing-slash form -- not the Metadata object that was written.
        assert.equal(response.headers.get('location'), `${collectionUrl}/`)

        const created = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(created.status, 200)
        assert.equal(created.data.id, collectionId)
        assert.deepStrictEqual(created.data.custom, {
          name: 'Created via meta'
        })
      }
    },
    {
      id: 'collection.meta-put-non-object-custom-400',
      name:
        '[root] PUT Collection Metadata with a non-object `custom` is ' +
        'rejected with 400 invalid-request-body',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        let expectedError: any
        try {
          await metaRequestOrSkip({
            ctx,
            alice,
            url: metaUrl,
            method: 'PUT',
            json: { custom: 'not-an-object' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a non-object `custom` to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'collection.meta-conditional-if-match',
      name:
        '[root] a stale `If-Match` on Collection Metadata 412s; the current ' +
        'one succeeds',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#conditional-requests',
        'https://w3id.org/pws#precondition-failed'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const { metaUrl } = await freshCollection({ ctx, alice })
        const created = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'One' } }
        })
        const currentEtag = created.headers.get('etag')
        assert.ok(currentEtag, 'expected an ETag on the metadata write')

        // A validator that cannot be current MUST NOT write, and MUST 412.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: metaUrl,
            method: 'PUT',
            action: 'PUT',
            json: { custom: { name: 'Two' } },
            headers: { 'if-match': '"99999"' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected a stale If-Match to be rejected')
        assert.equal(expectedError.response.status, 412)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#precondition-failed'
        )

        // The rejected write left the stored metadata alone.
        const unchanged = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.deepStrictEqual(unchanged.data.custom, { name: 'One' })

        // The matching precondition is satisfied: the write proceeds.
        const updated = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { custom: { name: 'Two' } },
          headers: { 'if-match': currentEtag }
        })
        assert.ok(
          updated.status === 204 || updated.status === 200,
          `expected a success status, got ${updated.status}`
        )
        assert.notEqual(updated.headers.get('etag'), currentEtag)

        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.deepStrictEqual(after.data.custom, { name: 'Two' })
      }
    },
    {
      id: 'collection.meta-configuration-and-annotation-share-etag',
      name:
        '[root] a configuration write and an annotation write on Collection ' +
        'Metadata advance the same ETag',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-versioning',
        'https://w3id.org/pws#conditional-requests'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // v0.5 merges what used to be two independent validators (the
        // Collection description's and the `/meta` annotation object's) into
        // the one Collection Metadata object's ETag, so a configuration
        // write and an annotation write now advance the SAME ETag rather
        // than independent ones.
        const { metaUrl } = await freshCollection({ ctx, alice })
        const created = await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'GET'
        })
        const createdEtag = created.headers.get('etag')
        assert.ok(createdEtag, 'expected an ETag on Collection Metadata')

        // An annotation write advances the one validator...
        const annotated = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'Metadata Collection', custom: { name: 'Shared' } }
        })
        const annotatedEtag = annotated.headers.get('etag')
        assert.notEqual(annotatedEtag, createdEtag)

        // ...and so does a configuration write (renaming the plaintext
        // `name` is a configuration member, not an annotation).
        const configured = await alice.rootClient.request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { name: 'Renamed Collection', custom: { name: 'Shared' } }
        })
        const configuredEtag = configured.headers.get('etag')
        assert.notEqual(configuredEtag, annotatedEtag)

        const meta = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(meta.headers.get('etag'), configuredEtag)
        assert.equal(meta.data.name, 'Renamed Collection')
        assert.deepStrictEqual(meta.data.custom, { name: 'Shared' })
      }
    },
    {
      id: 'collection.meta-delete-405-not-reserved-id',
      name:
        '[root] DELETE at the Collection Metadata URL is 405 with an Allow ' +
        'header, not a reserved-id 409',
      group: 'Collection Metadata',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#methods-at-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        // `meta` occupies the Collection's `:resourceId` position, so `meta`
        // is a reserved Resource id -- but there is no DELETE defined at
        // `meta` (spec "Lifecycle": deleting the Collection removes its
        // Metadata object with it), so v0.5's Methods at Reserved Endpoints
        // rule answers 405 here, never the reserved-id 409.
        const { metaUrl } = await freshCollection({ ctx, alice })
        await metaRequestOrSkip({ ctx, alice, url: metaUrl, method: 'GET' })

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: metaUrl,
            method: 'DELETE',
            action: 'DELETE'
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a DELETE at the Collection Metadata URL to be refused'
        )
        assert.equal(expectedError.response.status, 405)
        const allow = (expectedError.response.headers.get('allow') ?? '')
          .split(',')
          .map((method: string) => method.trim())
          .filter(Boolean)
        assert.ok(!allow.includes('DELETE'), 'Allow must not include DELETE')
        assert.equal(expectedError.data.type, 'about:blank')
        assert.notEqual(
          expectedError.data.type,
          'https://w3id.org/pws#reserved-id'
        )
      }
    },
    {
      id: 'collection.meta-update-omits-backend-keeps-selection',
      name:
        '[root] a Collection Metadata update omitting `backend` keeps the ' +
        'stored selection',
      group: 'Collection Metadata',
      // Proving retention (rather than a no-op default-to-default) needs a
      // genuinely non-default backend, which requires the reference server's
      // backend-registration write endpoint -- a facility the spec does not
      // define the wire contract of (only `GET .../backends` is spec'd).
      // Skip gracefully wherever that facility, or Collection Metadata
      // itself, is unavailable.
      optional: true,
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice } = state
        const backendId = generateId()
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/backends`,
              serverUrl
            ).toString(),
            method: 'POST',
            action: 'POST',
            json: {
              id: backendId,
              provider: 'google-drive',
              connection: {
                kind: 'oauth2-google',
                authorizationCode: 'probe-code'
              }
            }
          })
        } catch {
          ctx.skip(
            'server does not support registering a non-default backend ' +
              '(reference-server extension, not spec-defined)'
          )
        }

        const collectionId = generateId()
        const collectionUrl = new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString()
        await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: {
            id: collectionId,
            name: 'Backend Retention Probe',
            backend: { id: backendId }
          }
        })
        const metaUrl = `${collectionUrl}/meta`

        // An update that omits `backend` must keep the stored selection, not
        // reset it to the default (spec "Update Collection": "Clearing it
        // would repoint the Collection at the default backend").
        await metaRequestOrSkip({
          ctx,
          alice,
          url: metaUrl,
          method: 'PUT',
          json: { name: 'Renamed, backend omitted' }
        })
        const after = await alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.deepStrictEqual(after.data.backend, { id: backendId })
      }
    }
  ]
}
