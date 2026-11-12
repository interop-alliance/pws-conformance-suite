/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- typed denial reasons on refused capability
 * invocations.
 *
 * Under the spec's Error Handling, an authorization denial against an
 * existing target is the merged `not-found` (404), so an unauthorized caller
 * cannot tell an absent target from one it may not see. A credential that is
 * present but fails verification describes the request instead, and MAY be
 * reported precisely as 400 `invalid-authorization-header`. The authz
 * profile's Errors list files "an expired or unresolvable delegation chain"
 * there. So a refused invocation is answered with either of those two today.
 *
 * Spec roadmap item WASS-32 will add two typed causes, as 404s a server MAY
 * name to the one caller entitled to know them: `capability-expired` (the
 * invoked capability, or one in its chain, has expired) and
 * `capability-revoked` (a capability in the chain has a stored revocation).
 * The request signature, the action and target match, and every delegation
 * proof are checked first, and the controller match before the revocation
 * lookup. So a named cause only reaches a caller holding the capability and
 * its invoking key. The cases here accept those two kinds where WASS-32 would
 * permit them, beside the answers the spec gives today.
 *
 * The typed cases are optional: the Error Type Registry does not carry the
 * two kinds yet. The case that a refusal for any other reason is not named
 * as a typed cause is required. The revocation cases go through the client's
 * `space.revoke()`, and skip when the server has no revocation endpoint.
 */
import {
  resourceUrl,
  rootCapabilityId,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import type {
  ConformanceContext,
  Suite,
  TestContext
} from '../harness/types.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  bob: any
  docUrl: string
  spaceId: string
  spaceUrl: string
}

const NOT_FOUND = 'https://w3id.org/pws#not-found'
const CAPABILITY_REVOKED = 'https://w3id.org/pws#capability-revoked'
const CAPABILITY_EXPIRED = 'https://w3id.org/pws#capability-expired'
const INVALID_AUTHORIZATION_HEADER =
  'https://w3id.org/pws#invalid-authorization-header'

/**
 * Asserts a refusal matches one of the accepted `[status, type]` answers.
 *
 * @param options {object}
 * @param options.status {number}   the response status
 * @param options.problem {any}   the problem body
 * @param options.accepted {Array<[number, string]>}   the accepted answers
 */
function assertRefusedAs({
  status,
  problem,
  accepted
}: {
  status?: number
  problem?: any
  accepted: Array<[number, string]>
}): void {
  const matched = accepted.some(
    ([acceptedStatus, acceptedType]) =>
      status === acceptedStatus && problem?.type === acceptedType
  )
  const expected = accepted
    .map(
      ([acceptedStatus, acceptedType]) => `${acceptedStatus} ${acceptedType}`
    )
    .join(', or ')
  assert.ok(
    matched,
    `expected ${expected}; got ${status} ${problem?.type ?? '(no type)'}`
  )
}

/**
 * Reads the suite's document under `capability`, signing as `signer`, and
 * returns the response status and problem body of the refusal (or the 200).
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}   the run context
 * @param options.state {State}   the suite state (supplies the document URL)
 * @param options.capability {any}   the capability to invoke
 * @param options.signer {any}   the invoking signer
 * @returns {Promise<{ status?: number; problem?: any }>}
 */
async function readDoc({
  ctx,
  state,
  capability,
  signer
}: {
  ctx: ConformanceContext
  state: State
  capability: any
  signer: any
}): Promise<{ status?: number; problem?: any }> {
  try {
    const response = await ctx.zcapClient({ signer }).request({
      url: state.docUrl,
      method: 'GET',
      action: 'GET',
      capability
    })
    return { status: response.status, problem: response.data }
  } catch (err: any) {
    return { status: err.response?.status, problem: err.data }
  }
}

/**
 * Delegates GET on the suite's document from Alice to her app and revokes it
 * through the client's `space.revoke()`, skipping the test when the server
 * has no revocation endpoint (the endpoint is not in the spec).
 *
 * @param options {object}
 * @param options.ctx {TestContext}   the test context (for `skip`)
 * @param options.state {State}   the suite state
 * @returns {Promise<any>}   the revoked capability
 */
async function delegateAndRevoke({
  ctx,
  state
}: {
  ctx: TestContext
  state: State
}): Promise<any> {
  const { alice, aliceDelegatedApp, spaceUrl, docUrl } = state
  // Rooted at the Space, not the document: a revocation is scoped to the
  // Space the chain roots in, so the document's own root would be refused.
  // The Space's root capability id is minted from its canonical
  // trailing-slash URL, so the parent capability here must match that form
  // or the chain fails to verify before revocation is ever reached.
  const capability = await alice.rootClient.delegate({
    capability: rootCapabilityId(spaceUrl),
    allowedActions: ['GET'],
    invocationTarget: docUrl,
    controller: aliceDelegatedApp.did
  })
  // The grant works before revocation, so a later refusal is the revocation.
  const before = await readDoc({
    ctx,
    state,
    capability,
    signer: aliceDelegatedApp.signer
  })
  assert.equal(before.status, 200)
  try {
    await alice.pws.space(state.spaceId).revoke(capability)
  } catch (err: any) {
    if ([404, 405, 501].includes(err.status)) {
      ctx.skip('zcap revocation endpoint not implemented')
    }
    throw err
  }
  return capability
}

export const denialReasonsApi: Suite<State> = {
  id: 'denial-reasons-api',
  name: 'Typed denial reasons',
  specRefs: ['https://w3id.org/pws#error-type-registry'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const aliceDelegatedApp: any = { ...ctx.actors.aliceDelegatedApp }
    const bob: any = { ...ctx.actors.bob }
    const spaceId = ctx.generateId()
    const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    const resourceId = ctx.generateId()

    await ctx.createSpace({
      spaceDescription: {
        id: spaceId,
        name: "Alice's Denial Reasons Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    const docUrl = resourceUrl({
      spaceUrl,
      collectionId: 'credentials',
      resourceId
    })
    await alice.rootClient.request({
      url: docUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })

    return { alice, aliceDelegatedApp, bob, docUrl, spaceId, spaceUrl }
  },

  teardown: async (ctx, state) => {
    try {
      await state.alice.rootClient.request({
        url: state.spaceUrl,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'denial.expired',
      name: '[delegated] an expired capability is refused (400 invalid-authorization-header, 404 not-found, or 404 capability-expired)',
      optional: true,
      specRefs: ['https://w3id.org/pws#error-type-registry'],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, docUrl } = state
        // Backdating `now` two hours also backdates the default `expires`
        // (`now` + 5 minutes), so the grant expired well past any verifier's
        // clock-skew grace.
        const capability = await alice.rootClient.delegate({
          allowedActions: ['GET'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did,
          now: Date.now() - 2 * 60 * 60 * 1000
        })
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: aliceDelegatedApp.signer
        })
        // The authz profile files an expired chain under 400
        // invalid-authorization-header, and Error Handling lets a server
        // mask a credential failure as not-found. WASS-32 adds the 404
        // capability-expired answer for the capability's own controller.
        assertRefusedAs({
          status,
          problem,
          accepted: [
            [400, INVALID_AUTHORIZATION_HEADER],
            [404, NOT_FOUND],
            [404, CAPABILITY_EXPIRED]
          ]
        })
      }
    },
    {
      id: 'denial.expired-other-holder',
      name: '[delegated] an expired capability invoked by someone other than its controller is not named as expired (400 invalid-authorization-header or 404 not-found)',
      optional: true,
      specRefs: ['https://w3id.org/pws#error-type-registry'],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, bob, docUrl } = state
        const capability = await alice.rootClient.delegate({
          allowedActions: ['GET'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did,
          now: Date.now() - 2 * 60 * 60 * 1000
        })
        // Bob holds a copy of the app's expired grant but not the app's key:
        // the controller match fails before expiry is judged. The spec answers
        // a failed verification with 400 invalid-authorization-header or the
        // masked not-found. WASS-32 keeps capability-expired from a caller
        // that fails those checks.
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: bob.signer
        })
        assertRefusedAs({
          status,
          problem,
          accepted: [
            [400, INVALID_AUTHORIZATION_HEADER],
            [404, NOT_FOUND]
          ]
        })
      }
    },
    {
      id: 'denial.revoked',
      name: '[delegated] a revoked capability is refused as capability-revoked (404)',
      optional: true,
      specRefs: ['https://w3id.org/pws#error-type-registry'],
      run: async (ctx, state) => {
        const capability = await delegateAndRevoke({ ctx, state })
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: state.aliceDelegatedApp.signer
        })
        assert.equal(status, 404)
        assert.equal(problem.type, CAPABILITY_REVOKED)
      }
    },
    {
      id: 'denial.revoked-other-holder',
      name: '[delegated] a revoked capability invoked by someone other than its controller is not named as revoked (400 invalid-authorization-header or 404 not-found)',
      optional: true,
      specRefs: ['https://w3id.org/pws#error-type-registry'],
      run: async (ctx, state) => {
        const capability = await delegateAndRevoke({ ctx, state })
        // Bob holds a copy of the revoked grant but not the app's key, so he
        // learns nothing about the revocation. His signature fails
        // verification, which the spec lets a server report as 400
        // invalid-authorization-header or mask as not-found.
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: state.bob.signer
        })
        assertRefusedAs({
          status,
          problem,
          accepted: [
            [400, INVALID_AUTHORIZATION_HEADER],
            [404, NOT_FOUND]
          ]
        })
      }
    },
    {
      id: 'denial.other-cause-not-found',
      name: '[delegated] a capability refused for any other reason is not named as a typed cause (404 not-found or 400 invalid-authorization-header)',
      specRefs: [
        'https://w3id.org/pws#error-type-registry',
        'https://w3id.org/pws#error-handling',
        'https://w3id.org/pws/authz-profile#capability-invocation'
      ],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, docUrl } = state
        // A live grant for POST only, invoked as GET: the action check fails.
        // The authz profile defines the GET, POST, PUT and DELETE actions.
        // Its Errors list does not say whether an action mismatch is a
        // failed verification (400 invalid-authorization-header) or a lack
        // of privilege (404 not-found), so both are accepted, as the
        // invocation-target suite does for a target mismatch. Neither may
        // be a typed cause.
        const capability = await alice.rootClient.delegate({
          allowedActions: ['POST'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did
        })
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: aliceDelegatedApp.signer
        })
        assertRefusedAs({
          status,
          problem,
          accepted: [
            [404, NOT_FOUND],
            [400, INVALID_AUTHORIZATION_HEADER]
          ]
        })
      }
    }
  ]
}
