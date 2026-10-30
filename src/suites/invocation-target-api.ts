/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- capability `invocationTarget` binding negatives.
 *
 * A capability authorizes exactly one URL: the request is authorized only when
 * the capability's `invocationTarget` matches the full request target (spec
 * "Authorization Actions and the Root Capability"). These tests delegate a
 * narrowly-scoped capability to Bob and have him invoke it against URLs it
 * does not name -- a sibling Resource, the parent Collection, a Resource in
 * another Space -- asserting the server rejects the invocation without
 * performing the operation. A well-behaved client refuses to construct such
 * an invocation (ezcap's confused-deputy guard), so the tests sign with the
 * low-level `signCapabilityInvocation` primitive and send a raw `fetch`.
 *
 * The spec permits either rejection shape: the invocation fails verification
 * (400 `invalid-authorization-header`, a failure describing the request), or
 * the server treats the caller as under-authorized for the target and returns
 * the privacy-merged `not-found` (404) mask. Either way the target's content
 * must not be disclosed and the operation must not be performed.
 */
import {
  collectionUrl as collectionUrlOf,
  resourceUrl,
  spaceUrlById
} from '@interop/was-client/paths'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  docAUrl: string
  docBUrl: string
  docCUrl: string
  collectionUrl: string
}

/**
 * Signs and sends a capability invocation against an arbitrary URL -- the
 * mismatched-target request a well-behaved client refuses to build.
 *
 * @param options {object}
 * @param options.url {string}   the request URL to invoke against
 * @param options.capability {IZcap}   the delegated capability to embed
 * @param options.action {string}   the HTTP method / capability action
 * @param options.invocationSigner {ISigner}   the invoker's signer
 * @returns {Promise<Response>}
 */
async function invokeCapabilityAt({
  url,
  capability,
  action,
  invocationSigner
}: {
  url: string
  capability: IZcap
  action: string
  invocationSigner: ISigner
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: action,
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capability,
    capabilityAction: action
  })
  return fetch(url, {
    method: action,
    headers: signatureHeaders as Record<string, string>
  })
}

/**
 * Asserts a mismatched-target invocation was rejected without disclosing the
 * target: either 400 `invalid-authorization-header` (the invocation fails
 * verification) or the privacy-merged `not-found` (404) mask, always as an
 * `application/problem+json` body -- never the target's content.
 *
 * @param response {Response}   the raw fetch response
 */
async function assertTargetMismatchRejected(response: Response): Promise<void> {
  assert.ok(
    response.status === 400 || response.status === 404,
    `expected the mismatched-target invocation to be rejected with 400 or ` +
      `404, got ${response.status}`
  )
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/problem\+json/
  )
  const problem: any = await response.json()
  assert.equal(
    problem.type,
    response.status === 404
      ? 'https://w3id.org/pws#not-found'
      : 'https://w3id.org/pws#invalid-authorization-header'
  )
}

export const invocationTargetApi: Suite<State> = {
  id: 'invocation-target-api',
  name: 'Capability invocationTarget binding',
  specRefs: ['https://w3id.org/pws/authz-profile#capability-invocation'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    const spaceId = ctx.generateId()
    alice.space1 = {
      id: spaceId,
      url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    }
    alice.space2 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Target Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space2.id,
        name: "Alice's Other Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // Space 1: a Collection with two sibling Resources.
    const spaceUrl = alice.space1.url
    const collectionUrl = collectionUrlOf({
      spaceUrl,
      collectionId: 'credentials'
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    const docAUrl = resourceUrl({
      spaceUrl,
      collectionId: 'credentials',
      resourceId: 'doc-a'
    })
    const docBUrl = resourceUrl({
      spaceUrl,
      collectionId: 'credentials',
      resourceId: 'doc-b'
    })
    await alice.rootClient.request({
      url: docAUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: 'doc-a', name: 'Delegated Resource' }
    })
    await alice.rootClient.request({
      url: docBUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: 'doc-b', name: 'Sibling Resource' }
    })
    // Space 2: a Resource under the same controller, in a different Space.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space2.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'notes', name: 'Notes' }
    })
    const docCUrl = new URL(
      `/space/${alice.space2.id}/notes/doc-c`,
      ctx.serverUrl
    ).toString()
    await alice.rootClient.request({
      url: docCUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: 'doc-c', name: 'Other-Space Resource' }
    })
    return { alice, bob, docAUrl, docBUrl, docCUrl, collectionUrl }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    for (const space of [alice.space1, alice.space2]) {
      try {
        await alice.rootClient.request({
          url: new URL(`/space/${space.id}/`, ctx.serverUrl).toString(),
          method: 'DELETE'
        })
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  tests: [
    {
      id: 'target.sibling-resource-read',
      name:
        '[delegated] a capability for one Resource does not read a sibling ' +
        'Resource',
      specRefs: ['https://w3id.org/pws/authz-profile#capability-invocation'],
      run: async (ctx, state) => {
        const { alice, bob, docAUrl, docBUrl } = state
        const zcap = await alice.was.grant({
          to: bob.did,
          actions: ['GET'],
          target: docAUrl,
          spaceUrl: alice.space1.url
        })
        const response = await invokeCapabilityAt({
          url: docBUrl,
          capability: zcap,
          action: 'GET',
          invocationSigner: bob.rootClient.invocationSigner
        })
        await assertTargetMismatchRejected(response)
      }
    },
    {
      id: 'target.sibling-resource-delete',
      name:
        '[delegated] a capability for one Resource does not delete a sibling ' +
        '(operation not performed)',
      specRefs: ['https://w3id.org/pws/authz-profile#capability-invocation'],
      run: async (ctx, state) => {
        const { alice, bob, docAUrl, docBUrl } = state
        const zcap = await alice.was.grant({
          to: bob.did,
          actions: ['DELETE'],
          target: docAUrl,
          spaceUrl: alice.space1.url
        })
        const response = await invokeCapabilityAt({
          url: docBUrl,
          capability: zcap,
          action: 'DELETE',
          invocationSigner: bob.rootClient.invocationSigner
        })
        await assertTargetMismatchRejected(response)

        // The operation must not have been performed: Alice still sees doc-b.
        const checkResponse = await alice.rootClient.request({
          url: docBUrl,
          method: 'GET'
        })
        assert.equal(checkResponse.status, 200)
        assert.equal(checkResponse.data.name, 'Sibling Resource')
      }
    },
    {
      id: 'target.parent-collection-list',
      name:
        '[delegated] a Resource-scoped capability does not list the parent ' +
        'Collection',
      specRefs: ['https://w3id.org/pws/authz-profile#capability-invocation'],
      run: async (ctx, state) => {
        const { alice, bob, docAUrl, collectionUrl } = state
        // The inverse of target attenuation: a capability scoped to a child
        // URL must not authorize its parent container.
        const zcap = await alice.was.grant({
          to: bob.did,
          actions: ['GET'],
          target: docAUrl,
          spaceUrl: alice.space1.url
        })
        const response = await invokeCapabilityAt({
          url: collectionUrl,
          capability: zcap,
          action: 'GET',
          invocationSigner: bob.rootClient.invocationSigner
        })
        await assertTargetMismatchRejected(response)
      }
    },
    {
      id: 'target.cross-space-read',
      name:
        '[delegated] a capability from one Space does not read a Resource ' +
        'in another Space (same controller)',
      specRefs: ['https://w3id.org/pws/authz-profile#capability-invocation'],
      run: async (ctx, state) => {
        const { alice, bob, docAUrl, docCUrl } = state
        // Both Spaces are Alice's: the binding under test is the capability's
        // URL scope, not the identity of the delegating controller.
        const zcap = await alice.was.grant({
          to: bob.did,
          actions: ['GET'],
          target: docAUrl,
          spaceUrl: alice.space1.url
        })
        const response = await invokeCapabilityAt({
          url: docCUrl,
          capability: zcap,
          action: 'GET',
          invocationSigner: bob.rootClient.invocationSigner
        })
        await assertTargetMismatchRejected(response)
      }
    }
  ]
}
