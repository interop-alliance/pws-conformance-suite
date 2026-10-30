/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- typed denial reasons on refused capability
 * invocations.
 *
 * Every authorization denial is a 404 whose body is the merged `not-found`
 * problem, so an unauthorized caller cannot tell an absent target from one it
 * may not see. A server MAY still name two causes to the one caller entitled
 * to know them, by `type` alone: `capability-expired` (the invoked capability,
 * or one in its chain, has expired) and `capability-revoked` (a capability in
 * the chain has a stored revocation). Both are safe to surface because of
 * where a verifier raises them: the request signature, the action and target
 * match, and every delegation proof are checked first, and the controller
 * match before the revocation lookup. So a named cause only ever reaches a
 * caller holding the capability and its invoking key, and tells it something
 * about its own grant.
 *
 * The typed cases are optional: the spec's Error Type Registry does not yet
 * carry the two kinds, and a server that folds them into `not-found` is still
 * conformant. The merge itself (a refusal for any other reason stays
 * `not-found`) is required. The revocation cases go through the client's
 * `space.revoke()`, and skip when the server has no revocation endpoint.
 */
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
}

const NOT_FOUND = 'https://w3id.org/pws#not-found'
const CAPABILITY_REVOKED = 'https://w3id.org/pws#capability-revoked'
const CAPABILITY_EXPIRED = 'https://w3id.org/pws#capability-expired'

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
  const { alice, aliceDelegatedApp, spaceId, docUrl } = state
  // Rooted at the Space, not the document: a revocation is scoped to the
  // Space the chain roots in, so the document's own root would be refused.
  // The Space's root capability id is minted from its canonical
  // trailing-slash URL, so the parent capability here must match that form
  // or the chain fails to verify before revocation is ever reached.
  const spaceUrl = new URL(`/space/${spaceId}/`, ctx.serverUrl).toString()
  const capability = await alice.rootClient.delegate({
    capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
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
    await alice.pws.space(spaceId).revoke(capability)
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
      url: new URL(`/space/${spaceId}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    const docUrl = new URL(
      `/space/${spaceId}/credentials/${resourceId}`,
      ctx.serverUrl
    ).toString()
    await alice.rootClient.request({
      url: docUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })

    return { alice, aliceDelegatedApp, bob, docUrl, spaceId }
  },

  teardown: async (ctx, state) => {
    try {
      await state.alice.rootClient.request({
        url: new URL(`/space/${state.spaceId}/`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'denial.expired',
      name: '[delegated] an expired capability is refused as capability-expired (404)',
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
        assert.equal(status, 404)
        assert.equal(problem.type, CAPABILITY_EXPIRED)
      }
    },
    {
      id: 'denial.expired-other-holder',
      name: '[delegated] an expired capability invoked by someone other than its controller is the plain not-found',
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
        // the controller match fails before expiry is judged.
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: bob.signer
        })
        assert.equal(status, 404)
        assert.equal(problem.type, NOT_FOUND)
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
      name: '[delegated] a revoked capability invoked by someone other than its controller is the plain not-found',
      optional: true,
      specRefs: ['https://w3id.org/pws#error-type-registry'],
      run: async (ctx, state) => {
        const capability = await delegateAndRevoke({ ctx, state })
        // Bob holds a copy of the revoked grant but not the app's key, so he
        // learns nothing about the revocation.
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: state.bob.signer
        })
        assert.equal(status, 404)
        assert.equal(problem.type, NOT_FOUND)
      }
    },
    {
      id: 'denial.other-cause-not-found',
      name: '[delegated] a capability refused for any other reason stays the merged not-found (404)',
      specRefs: [
        'https://w3id.org/pws#error-type-registry',
        'https://w3id.org/pws#error-handling'
      ],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, docUrl } = state
        // A live grant for HEAD only, invoked as GET: the action check fails,
        // and the answer is the same masked not-found any denial carries.
        const capability = await alice.rootClient.delegate({
          allowedActions: ['HEAD'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did
        })
        const { status, problem } = await readDoc({
          ctx,
          state,
          capability,
          signer: aliceDelegatedApp.signer
        })
        assert.equal(status, 404)
        assert.equal(problem.type, NOT_FOUND)
      }
    }
  ]
}
