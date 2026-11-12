/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- write-validation negatives.
 *
 * Covers two MUST-level rejections of malformed create requests: a
 * client-chosen Collection id that collides with the spec's Reserved Path
 * Segment Registry (409 `reserved-id`), and a Resource write that carries no
 * `Content-Type` header (400 `missing-content-type`). The reserved-id case
 * covers the one wire shape where the client names the id, a POST body `id`.
 * A create-by-id `PUT` at `.../{reserved}/meta` names no Collection: the URL
 * lies beneath a reserved endpoint, so it is not found (404), as is any other
 * path beneath a reserved segment that no endpoint defines. A Resource id has
 * no reserved-id case: the server generates the id on Create Resource, and a
 * reserved segment in the Resource position is a reserved endpoint (see
 * reserved-methods-api). The Content-Type test signs with the low-level
 * `signCapabilityInvocation` primitive and sends raw bytes via `fetch`, since
 * a well-behaved client always sets a content type.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import { collectionUrl, spaceUrlById } from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  spaceUrl: string
}

/**
 * Asserts a rejected create reports a reserved-id collision: status 409 and
 * the `reserved-id` type.
 *
 * @param expectedError {any}   the error thrown by ZcapClient.request()
 */
function assertReservedId(expectedError: any): void {
  assert.ok(expectedError, 'expected the reserved id to be rejected')
  assert.equal(expectedError.response.status, 409)
  assert.equal(expectedError.data.type, 'https://w3id.org/pws#reserved-id')
}

/**
 * Asserts a request for a path beneath a reserved segment was not found:
 * status 404 and not a `reserved-id` conflict. The body shape is not asserted,
 * since the spec leaves an unmatched URL's body to the server.
 *
 * @param expectedError {any}   the error thrown by ZcapClient.request()
 */
function assertNotFoundBeneathReservedSegment(expectedError: any): void {
  assert.ok(expectedError, 'expected the request to be refused')
  assert.equal(expectedError.response.status, 404)
  assert.notEqual(
    expectedError.data?.type,
    'https://w3id.org/pws#reserved-id',
    'a path beneath a reserved segment is not found, not an id conflict'
  )
}

export const writeValidationApi: Suite<State> = {
  id: 'write-validation-api',
  name: 'Write-validation negatives (reserved ids, Content-Type)',
  specRefs: [
    'https://w3id.org/pws#reserved-path-segment-registry',
    'https://w3id.org/pws#content-types-and-representations'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    const spaceUrl = spaceUrlById({
      baseServerUrl: ctx.serverUrl,
      spaceId: alice.space1.id
    })
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Write-Validation Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: 'docs', name: 'Documents' }
    })
    return { alice, spaceUrl }
  },

  teardown: async (ctx, state) => {
    const { alice, spaceUrl } = state
    try {
      await alice.rootClient.request({
        url: spaceUrl,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'write-validation.collection-reserved-id-post',
      name:
        '[root] creating a Collection whose body `id` is a reserved segment ' +
        '(`query`) is rejected with 409 reserved-id',
      specRefs: [
        'https://w3id.org/pws#space-level-reserved-endpoints',
        'https://w3id.org/pws#reserved-id'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl,
            method: 'POST',
            action: 'POST',
            json: { id: 'query', name: 'Reserved Collection Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assertReservedId(expectedError)
      }
    },
    {
      id: 'write-validation.collection-reserved-id-put',
      name:
        '[root] a create-by-id PUT at a reserved path segment ' +
        '(`export/meta`) is not found (404), not a reserved-id conflict',
      specRefs: [
        'https://w3id.org/pws#space-level-reserved-endpoints',
        'https://w3id.org/pws#update-or-create-by-id-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        // Create-by-id is a PUT of the Collection's Metadata object. With a
        // reserved segment in the Collection position the URL lies beneath
        // the `export` endpoint and names no Collection, so the server
        // answers as it does for any unmatched URL rather than reading the
        // segment as an id and refusing it as a conflict. Either way no
        // Collection named `export` comes to exist. The URL is formed by hand
        // because the path builders refuse a reserved segment as an id.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: `${spaceUrl}export/meta`,
            method: 'PUT',
            action: 'PUT',
            json: { name: 'Reserved Collection Id Probe' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundBeneathReservedSegment(expectedError)
      }
    },
    {
      id: 'write-validation.reserved-segment-path-not-found',
      name:
        '[root] a path beneath a reserved segment that no endpoint defines ' +
        '(`export/x`) is not found (404)',
      specRefs: ['https://w3id.org/pws#space-level-reserved-endpoints'],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        let expectedError: any
        try {
          // Formed by hand: the path builders refuse a reserved segment.
          await alice.rootClient.request({
            url: `${spaceUrl}export/x`,
            method: 'GET',
            action: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundBeneathReservedSegment(expectedError)
      }
    },
    {
      id: 'write-validation.resource-missing-content-type',
      name:
        '[root] a Resource write without a `Content-Type` header is ' +
        'rejected with 400 missing-content-type',
      specRefs: [
        'https://w3id.org/pws#content-types-and-representations',
        'https://w3id.org/pws#missing-content-type'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        const url = collectionUrl({ spaceUrl, collectionId: 'docs' })
        // Sign a bodyless invocation: with no `Content-Type` on the request,
        // the signature legitimately covers neither `content-type` nor
        // `digest`, so the write reaches the content-type check itself.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'POST',
          headers: { date: new Date().toUTCString() },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'POST'
        })
        // A byte-array body keeps `fetch` from inferring a Content-Type of
        // its own (a string body would get `text/plain` added implicitly).
        const response = await fetch(url, {
          method: 'POST',
          headers: signatureHeaders as Record<string, string>,
          body: new TextEncoder().encode('no content type')
        })
        // `application/problem+json` is a SHOULD, so the media type is not
        // asserted. The `type` member is REQUIRED.
        assert.equal(response.status, 400)
        const problem: any = await response.json()
        assert.equal(problem.type, 'https://w3id.org/pws#missing-content-type')
      }
    }
  ]
}
