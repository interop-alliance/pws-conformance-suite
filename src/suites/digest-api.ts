/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- request-body integrity (Digest) negatives.
 *
 * The spec's "Request Body Integrity (Digest Header)" profile binds a request
 * body to its HTTP Signature: for any request carrying a `Content-Type`, the
 * server MUST require `digest` among the signature's covered headers, and
 * SHOULD independently recompute the digest of the received body and compare
 * it. Both failures are rejected with `invalid-authorization-header` (400).
 * The core spec's error-handling rules let a server report a credential
 * failure precisely or mask it as `not-found` (404), so the tests accept
 * either. A well-behaved client never produces such requests, so these tests
 * sign with the low-level `signCapabilityInvocation` primitive and send the
 * malformed request with a raw `fetch`.
 */
import { createHeaderValue } from '@interop/http-digest-header'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import { resourceUrl, spaceUrlById } from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  spaceUrl: string
}

/**
 * Asserts a rejected request reports the digest-binding failure. A server MAY
 * report it precisely, as 400 with the `invalid-authorization-header` type
 * (the registry's single type for all authorization-header failures), or mask
 * it as 404 with the `not-found` type. `application/problem+json` is a SHOULD,
 * so the media type is not asserted.
 *
 * @param response {Response}   the raw fetch response
 */
async function assertCredentialFailure(response: Response): Promise<void> {
  assert.ok(
    response.status === 400 || response.status === 404,
    `expected 400 or 404, got ${response.status}`
  )
  const problem: any = await response.json()
  const expectedType =
    response.status === 400
      ? 'https://w3id.org/pws#invalid-authorization-header'
      : 'https://w3id.org/pws#not-found'
  assert.equal(problem.type, expectedType)
}

export const digestApi: Suite<State> = {
  id: 'digest-api',
  name: 'Request body integrity (Digest) negatives',
  specRefs: [
    'https://w3id.org/pws/authz-profile#request-body-integrity-digest-header'
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
        name: "Alice's Digest Space",
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
      id: 'digest.signature-not-covering-digest',
      name:
        '[root] a signed body request whose signature does not cover the ' +
        '`digest` header is rejected (400 invalid-authorization-header, ' +
        'or the 404 not-found mask)',
      specRefs: [
        'https://w3id.org/pws/authz-profile#request-body-integrity-digest-header',
        'https://w3id.org/pws#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        const url = resourceUrl({
          spaceUrl,
          collectionId: 'docs',
          resourceId: ctx.generateId()
        })
        const body = JSON.stringify({ name: 'Uncovered Digest Probe' })
        // Sign as if the request were bodyless: a valid signature whose
        // covered headers omit `content-type` and `digest`.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'PUT',
          headers: { date: new Date().toUTCString() },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'PUT'
        })
        // The `Digest` header itself is present and correct for the body sent
        // -- only its signature coverage is missing, which the server MUST
        // require for any request carrying a `Content-Type`.
        const digest = await createHeaderValue({
          data: body,
          algorithm: 'sha256',
          useMultihash: true
        })
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            ...(signatureHeaders as Record<string, string>),
            'content-type': 'application/json',
            digest
          },
          body
        })
        await assertCredentialFailure(response)
      }
    },
    {
      id: 'digest.body-tampered-after-signing',
      name:
        '[root] a request whose body does not match its signed `digest` ' +
        '(tampered after signing) is rejected (400, or the 404 mask)',
      // Independent recomputation of the received body's digest is a SHOULD.
      optional: true,
      specRefs: [
        'https://w3id.org/pws/authz-profile#request-body-integrity-digest-header',
        'https://w3id.org/pws#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl } = state
        const url = resourceUrl({
          spaceUrl,
          collectionId: 'docs',
          resourceId: ctx.generateId()
        })
        // A fully well-formed signing of the original body: the signature
        // covers `digest`, and the `Digest` header matches the original.
        const signatureHeaders = await signCapabilityInvocation({
          url,
          method: 'PUT',
          headers: { date: new Date().toUTCString() },
          json: { name: 'Original Body' },
          invocationSigner: alice.rootClient.invocationSigner,
          capabilityAction: 'PUT'
        })
        // ...but the body actually sent was swapped after signing.
        const response = await fetch(url, {
          method: 'PUT',
          headers: signatureHeaders as Record<string, string>,
          body: JSON.stringify({ name: 'Tampered Body' })
        })
        await assertCredentialFailure(response)

        // The tampered write must not have been performed.
        let expectedError: any
        try {
          await alice.rootClient.request({ url, method: 'GET' })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the tampered resource to not exist')
        assert.equal(expectedError.response.status, 404)
      }
    }
  ]
}
