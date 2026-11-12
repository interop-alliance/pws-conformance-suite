/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- authorization-ordering negatives.
 *
 * The spec's "maximum privacy" rule (spec "Error Handling") requires servers
 * to verify a caller's authorization *before* any check whose distinct error
 * would reveal that a target exists: conflict detection (409), encrypted-write
 * envelope validation (422), cursor / query-body validation (400/501), and
 * quota reads (403). A server that runs those checks first leaks existence
 * through the differing status code. Every test here invokes as Bob -- a
 * well-formed, signed request that simply lacks privilege over Alice's Space
 * -- and expects the privacy-merged `not-found` (404) mask.
 *
 * Quotas are an OPTIONAL extension, advertised by the `quotas` features
 * token. The two quota cases skip on a server that does not list it.
 */
import {
  collectionQueryUrl,
  collectionQuotaUrl,
  collectionUrl,
  resourceUrl,
  spaceQuotasUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  resourceId: string
  spaceUrl: string
  quotasAdvertised: boolean
}

const NOT_FOUND = 'https://w3id.org/pws#not-found'
const UNSUPPORTED_OPERATION = 'https://w3id.org/pws#unsupported-operation'

/**
 * Asserts a rejected request carries the privacy-merged `not-found` mask:
 * status 404 and the single merged `type` (the registry forbids splitting
 * `not-found` into distinguishable kinds). The `application/problem+json`
 * content type is a SHOULD in Error Handling, so it is not checked.
 *
 * @param expectedError {any}   the error thrown by `ZcapClient.request()`
 */
function assertNotFoundMask(expectedError: any): void {
  assert.ok(expectedError, 'expected the under-authorized request to fail')
  assert.equal(expectedError.response.status, 404)
  assert.equal(expectedError.data?.type, NOT_FOUND)
}

export const authzOrderingApi: Suite<State> = {
  id: 'authz-ordering-api',
  name: 'Authorization ordering (no-leak negatives)',
  specRefs: ['https://w3id.org/pws#error-handling'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    const spaceUrl = spaceUrlById({
      baseServerUrl: ctx.serverUrl,
      spaceId: alice.space1.id
    })
    const resourceId = ctx.generateId()
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Ordering Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // A plain Collection holding one Resource (the existing ids Bob probes for)
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    await alice.rootClient.request({
      url: resourceUrl({ spaceUrl, collectionId: 'credentials', resourceId }),
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, name: 'Existing Resource' }
    })
    // An encryption-marked Collection (for the envelope-validation ordering test)
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: 'vault', name: 'Vault', encryption: { scheme: 'edv' } }
    })
    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    const quotasAdvertised = features.includes('quotas')
    return { alice, bob, resourceId, spaceUrl, quotasAdvertised }
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
      id: 'ordering.collection-post-conflict-404',
      name: "[root] Bob's POST of an existing Collection id yields 404, not id-conflict (409)",
      specRefs: [
        'https://w3id.org/pws#id-conflict',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, spaceUrl } = state
        // Authorization MUST run before conflict detection: a 409 here would
        // let Bob probe Alice's Space for existing Collection ids.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: spaceUrl,
            method: 'POST',
            action: 'POST',
            json: { id: 'credentials', name: 'Probe Collection' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.encrypted-write-404',
      name: "[root] Bob's plaintext write to an encrypted Collection yields 404, not scheme-mismatch (422)",
      specRefs: [
        'https://w3id.org/pws#encryption-scheme-mismatch',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, spaceUrl } = state
        // Authorization MUST run before envelope validation: a 422 here would
        // reveal both that `vault` exists and that it is encryption-marked.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: resourceUrl({
              spaceUrl,
              collectionId: 'vault',
              resourceId: 'plaintext-doc'
            }),
            method: 'PUT',
            action: 'PUT',
            json: { hello: 'world' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.list-bad-cursor-404',
      name: "[root] Bob's List Collection with a malformed cursor yields 404, not invalid-cursor (400)",
      specRefs: [
        'https://w3id.org/pws#invalid-cursor',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, spaceUrl } = state
        // Authorization MUST run before cursor validation: pagination params
        // describe the request, but validating them first would answer before
        // the 404 mask is decided.
        let expectedError: any
        try {
          const listUrl = collectionUrl({
            spaceUrl,
            collectionId: 'credentials'
          })
          await bob.rootClient.request({
            url: `${listUrl}?cursor=not-valid-%%%`,
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.query-bad-body-404',
      name: "[root] Bob's query POST with an invalid body yields 404, not 400/501",
      specRefs: ['https://w3id.org/pws#not-found'],
      run: async (ctx, state) => {
        const { bob, spaceUrl } = state
        // An authorized caller sending this body gets a precise query-body
        // error (an unknown profile is 501); Bob must get the 404 mask first.
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: collectionQueryUrl({ spaceUrl, collectionId: 'credentials' }),
            method: 'POST',
            action: 'POST',
            json: { profile: 'no-such-profile' }
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.space-quotas-read-404',
      name: "[root] Bob's read of Alice's Space quota report yields 404, not 403",
      specRefs: [
        'https://w3id.org/pws#quotas',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, spaceUrl, quotasAdvertised } = state
        // Quotas are an OPTIONAL extension (spec "Quotas"); a server that
        // does not list the `quotas` token has no quota report to mask.
        if (!quotasAdvertised) {
          ctx.skip('the server does not advertise the quotas feature')
        }
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: spaceQuotasUrl({ spaceUrl }),
            method: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.collection-quota-read-404',
      name: "[root] Bob's read of Alice's Collection quota yields 404 or 501, not 403",
      specRefs: [
        'https://w3id.org/pws#quotas',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, spaceUrl, quotasAdvertised } = state
        if (!quotasAdvertised) {
          ctx.skip('the server does not advertise the quotas feature')
        }
        // Per-Collection accounting is optional. The endpoint's Errors list
        // names 404 not-found (absent, or not authorized) and 501
        // unsupported-operation (no per-Collection accounting) with no order
        // between them, so either is accepted. A 403 never is.
        let expectedError: any
        try {
          const quotaUrl = collectionQuotaUrl({
            spaceUrl,
            collectionId: 'credentials'
          })
          await bob.rootClient.request({ url: quotaUrl, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the under-authorized request to fail'
        )
        if (expectedError.response.status === 501) {
          assert.equal(expectedError.data?.type, UNSUPPORTED_OPERATION)
          return
        }
        assertNotFoundMask(expectedError)
      }
    },
    {
      id: 'ordering.resource-delete-404',
      name: "[root] Bob's DELETE of Alice's Resource yields 404 and does not delete it",
      specRefs: ['https://w3id.org/pws#not-found'],
      run: async (ctx, state) => {
        const { alice, bob, resourceId, spaceUrl } = state
        const docUrl = resourceUrl({
          spaceUrl,
          collectionId: 'credentials',
          resourceId
        })
        let expectedError: any
        try {
          await bob.rootClient.request({ url: docUrl, method: 'DELETE' })
        } catch (err) {
          expectedError = err
        }
        assertNotFoundMask(expectedError)

        // The operation must not have been performed: Alice still sees it.
        const checkResponse = await alice.rootClient.request({
          url: docUrl,
          method: 'GET'
        })
        assert.equal(checkResponse.status, 200)
        assert.equal(checkResponse.data.name, 'Existing Resource')
      }
    }
  ]
}
