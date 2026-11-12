/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- the container rule (authorization profile "The
 * Container Rule").
 *
 * Target attenuation stops working for four operations, because a capability
 * delegated at a container's `invocationTarget` -- a Space URL or a Collection
 * URL -- covers everything beneath it, so nothing about that target tells
 * apart "delete this container" from "delete a Resource inside it". The four
 * therefore MUST be authorized by a root capability invoked directly by the
 * Space controller, with exactly two exceptions:
 *
 * - Delete Space (`DELETE /space/{s}/`) also accepts a delegated capability
 *   whose invoked grant targets exactly that Space's canonical
 *   trailing-slash URL with `allowedAction` exactly `['DELETE']`.
 * - Update (or Create by Id) Collection (`PUT /space/{s}/{c}/meta`) accepts
 *   a delegated capability whose invoked grant targets the Space's canonical
 *   trailing-slash URL. A grant on the Collection URL, the Collection
 *   Metadata URL, or a Resource URL does not qualify: it is a
 *   Collection-level data grant, and the write is refused.
 *
 * `PUT /space/{s}/meta` on an existing Space and
 * `DELETE /space/{s}/{c}/` take no delegated capability at all. Creating a
 * Collection (`POST /space/{s}/`) is unaffected and stays delegable, which is
 * asserted here too so the rule is not read as covering every container write.
 *
 * A refusal is an ordinary authorization denial: the masked `not-found` (404),
 * with nothing changed behind it. Every refusal case re-reads the target with
 * the root client afterwards, so a server that answers 404 while performing
 * the operation anyway does not pass.
 *
 * Every delegated capability here targets the Space URL or a URL beneath it:
 * `@interop/ezcap` refuses client-side to sign an invocation whose capability
 * target is not a prefix of the request URL, so a grant outside that shape
 * never reaches the wire and could not be tested against a server at all.
 */
import {
  collectionMetaUrl,
  collectionUrl,
  rootCapabilityId,
  spaceMetaUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import { capabilityActionFor } from '../helpers.js'
import assert from '../harness/assert.js'
import type { Suite, TestContext } from '../harness/types.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  /** Every Space provisioned by a test, removed in teardown. */
  spaceIds: string[]
}

const NOT_FOUND = 'https://w3id.org/pws#not-found'
const CONTAINER_RULE = 'https://w3id.org/pws/authz-profile#the-container-rule'

/**
 * Provisions a fresh Space controlled by Alice and records it for teardown.
 * Each test gets its own, since half of them delete or rewrite the container
 * they act on.
 *
 * @param options {object}
 * @param options.ctx {TestContext}
 * @param options.state {State}
 * @param options.name {string}   the Space name
 * @returns {Promise<string>}   the new Space id
 */
async function provisionSpace({
  ctx,
  state,
  name
}: {
  ctx: TestContext
  state: State
  name: string
}): Promise<string> {
  const spaceId = ctx.generateId()
  await ctx.createSpace({
    spaceDescription: { id: spaceId, name, controller: state.alice.did },
    rootClient: state.alice.rootClient
  })
  state.spaceIds.push(spaceId)
  return spaceId
}

/**
 * Delegates a capability to Alice's app, rooted in the Space's own root
 * capability. The root is named explicitly because the server synthesizes it
 * from the Space's canonical trailing-slash URL; a grant whose target is a
 * Collection or a Metadata object would otherwise default to a root the
 * server never mints.
 *
 * @param options {object}
 * @param options.ctx {TestContext}
 * @param options.state {State}
 * @param options.spaceId {string}
 * @param options.invocationTarget {string}   the delegated target URL
 * @param options.allowedActions {string[]}
 * @returns {Promise<any>}   the delegated capability
 */
async function delegateInSpace({
  ctx,
  state,
  spaceId,
  invocationTarget,
  allowedActions
}: {
  ctx: TestContext
  state: State
  spaceId: string
  invocationTarget: string
  allowedActions: string[]
}): Promise<any> {
  const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
  return state.alice.rootClient.delegate({
    capability: rootCapabilityId(spaceUrl),
    allowedActions,
    invocationTarget,
    controller: state.aliceDelegatedApp.did
  })
}

/**
 * Sends a request, returning the status and body whether the client resolved
 * or threw. The high-level client throws on 4xx/5xx, and every refusal here is
 * a 404 that must still be inspected.
 *
 * @param options {object}
 * @param options.ctx {TestContext}
 * @param options.signer {any}   the invoking signer
 * @param options.url {string}
 * @param options.method {string}
 * @param [options.capability] {any}   a delegated capability, or none for a
 *   direct root invocation
 * @param [options.json] {object}
 * @returns {Promise<{ status?: number; data?: any }>}
 */
async function invoke({
  ctx,
  signer,
  url,
  method,
  capability,
  json
}: {
  ctx: TestContext
  signer: any
  url: string
  method: string
  capability?: any
  json?: object
}): Promise<{ status?: number; data?: any }> {
  try {
    const response = await ctx.zcapClient({ signer }).request({
      url,
      method,
      action: capabilityActionFor(method),
      ...(capability && { capability }),
      ...(json && { json })
    })
    return { status: response.status, data: response.data }
  } catch (err: any) {
    return { status: err.response?.status, data: err.data }
  }
}

/**
 * Asserts one refused invocation: the masked `not-found` (404) of the spec's
 * Error Type Registry, and nothing else.
 *
 * @param options {object}
 * @param options.result {{ status?: number; data?: any }}
 * @param options.message {string}   what was expected to be refused
 * @returns {void}
 */
function assertRefused({
  result,
  message
}: {
  result: { status?: number; data?: any }
  message: string
}): void {
  assert.equal(result.status, 404, `${message}: expected a 404 refusal`)
  assert.equal(
    result.data?.type,
    NOT_FOUND,
    `${message}: expected the masked not-found problem type`
  )
}

export const containerRuleApi: Suite<State> = {
  id: 'container-rule-api',
  name: 'The container rule',
  specRefs: [CONTAINER_RULE],

  setup: async ctx => ({
    alice: { ...ctx.actors.alice },
    aliceDelegatedApp: { ...ctx.actors.aliceDelegatedApp },
    spaceIds: []
  }),

  teardown: async (ctx, state) => {
    for (const spaceId of state.spaceIds) {
      try {
        await state.alice.rootClient.request({
          url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId }),
          method: 'DELETE'
        })
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  tests: [
    {
      id: 'container-rule.space-meta-put-root',
      name: '[root] PUT /space/:s/meta on an existing Space is authorized by a direct root invocation',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Space Metadata (root)'
        })
        const metaUrl = spaceMetaUrl({
          spaceUrl: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        })
        const result = await invoke({
          ctx,
          signer: state.alice.signer,
          url: metaUrl,
          method: 'PUT',
          json: {
            id: spaceId,
            name: 'Renamed By The Controller',
            controller: state.alice.did
          }
        })
        assert.ok(
          result.status === 200 || result.status === 204,
          `expected the controller's own PUT to succeed, got ${result.status}`
        )
        const after = await state.alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.data.name, 'Renamed By The Controller')
      }
    },
    {
      id: 'container-rule.space-meta-put-delegated-refused',
      name: '[delegated] PUT /space/:s/meta on an existing Space is refused (404) whatever the grant',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Space Metadata (delegated)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const metaUrl = spaceMetaUrl({ spaceUrl })
        // Two shapes a wallet actually mints: a PUT-only Space grant, and the
        // whole-verb-set generation grant. Update Space Metadata takes
        // neither -- it is controller-only.
        const grants = [['PUT'], ['GET', 'POST', 'PUT', 'DELETE']]
        for (const allowedActions of grants) {
          const capability = await delegateInSpace({
            ctx,
            state,
            spaceId,
            invocationTarget: spaceUrl,
            allowedActions
          })
          const result = await invoke({
            ctx,
            signer: state.aliceDelegatedApp.signer,
            url: metaUrl,
            method: 'PUT',
            capability,
            json: {
              id: spaceId,
              name: 'Seized By A Delegate',
              controller: state.aliceDelegatedApp.did
            }
          })
          assertRefused({
            result,
            message: `a delegated PUT with allowedAction ${allowedActions.join('/')}`
          })
        }
        // Nothing was written: Alice still controls the Space, name intact.
        const after = await state.alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.controller, state.alice.did)
        assert.equal(
          after.data.name,
          'Container Rule -- Space Metadata (delegated)'
        )
      }
    },
    {
      id: 'container-rule.collection-delete-root',
      name: '[root] DELETE /space/:s/:c/ is authorized by a direct root invocation',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Delete Collection (root)'
        })
        const collectionId = ctx.generateId()
        await state.alice.rootClient.request({
          url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId }),
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: 'Doomed Collection' }
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const result = await invoke({
          ctx,
          signer: state.alice.signer,
          url: collectionUrl({ spaceUrl, collectionId }),
          method: 'DELETE'
        })
        assert.equal(result.status, 204)
        const after = await invoke({
          ctx,
          signer: state.alice.signer,
          url: collectionMetaUrl({ spaceUrl, collectionId }),
          method: 'GET'
        })
        assert.equal(after.status, 404, 'the Collection should be gone')
      }
    },
    {
      id: 'container-rule.collection-delete-delegated-refused',
      name: '[delegated] DELETE /space/:s/:c/ is refused (404) whatever the grant',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Delete Collection (delegated)'
        })
        const collectionId = ctx.generateId()
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        await state.alice.rootClient.request({
          url: spaceUrl,
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: 'Kept Collection' }
        })
        const containerUrl = collectionUrl({ spaceUrl, collectionId })
        // The Space-subtree grant, and the narrowest grant there is: DELETE
        // alone on exactly this Collection. Delete Collection has no
        // exception, so both are refused.
        const grants = [
          { invocationTarget: spaceUrl, allowedActions: ['DELETE'] },
          { invocationTarget: containerUrl, allowedActions: ['DELETE'] }
        ]
        for (const grant of grants) {
          const capability = await delegateInSpace({
            ctx,
            state,
            spaceId,
            ...grant
          })
          const result = await invoke({
            ctx,
            signer: state.aliceDelegatedApp.signer,
            url: containerUrl,
            method: 'DELETE',
            capability
          })
          assertRefused({
            result,
            message: `a delegated DELETE targeting ${grant.invocationTarget}`
          })
        }
        // The Collection is still there.
        const after = await state.alice.rootClient.request({
          url: collectionMetaUrl({ spaceUrl, collectionId }),
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.name, 'Kept Collection')
      }
    },
    {
      id: 'container-rule.space-delete-root',
      name: '[root] DELETE /space/:s/ is authorized by a direct root invocation',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Delete Space (root)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const result = await invoke({
          ctx,
          signer: state.alice.signer,
          url: spaceUrl,
          method: 'DELETE'
        })
        assert.equal(result.status, 204)
        const after = await invoke({
          ctx,
          signer: state.alice.signer,
          url: spaceMetaUrl({ spaceUrl }),
          method: 'GET'
        })
        assert.equal(after.status, 404, 'the Space should be gone')
      }
    },
    {
      id: 'container-rule.space-delete-delegated-exact',
      name: '[delegated] DELETE /space/:s/ is authorized by an exact-target DELETE-only grant',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Delete Space (delegated)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const capability = await delegateInSpace({
          ctx,
          state,
          spaceId,
          invocationTarget: spaceUrl,
          allowedActions: ['DELETE']
        })
        const result = await invoke({
          ctx,
          signer: state.aliceDelegatedApp.signer,
          url: spaceUrl,
          method: 'DELETE',
          capability
        })
        assert.equal(
          result.status,
          204,
          'the first container-rule exception must be honored'
        )
        const after = await invoke({
          ctx,
          signer: state.alice.signer,
          url: spaceMetaUrl({ spaceUrl }),
          method: 'GET'
        })
        assert.equal(after.status, 404, 'the Space should be gone')
      }
    },
    {
      id: 'container-rule.space-delete-delegated-two-verb-refused',
      name: '[delegated] DELETE /space/:s/ under a two-verb grant on the Space URL is refused (404)',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Delete Space (two-verb)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        // Exactly `['DELETE']` is what the exception names. A grant carrying
        // DELETE alongside a read verb is a data grant, and is refused.
        const capability = await delegateInSpace({
          ctx,
          state,
          spaceId,
          invocationTarget: spaceUrl,
          allowedActions: ['GET', 'DELETE']
        })
        const result = await invoke({
          ctx,
          signer: state.aliceDelegatedApp.signer,
          url: spaceUrl,
          method: 'DELETE',
          capability
        })
        assertRefused({
          result,
          message: 'a delegated DELETE under a GET/DELETE grant'
        })
        // The Space survived the refusal.
        const after = await state.alice.rootClient.request({
          url: spaceMetaUrl({ spaceUrl }),
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.controller, state.alice.did)
      }
    },
    {
      id: 'container-rule.collection-meta-put-root',
      name: '[root] PUT /space/:s/:c/meta is authorized by a direct root invocation',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Collection Metadata (root)'
        })
        const collectionId = ctx.generateId()
        const metaUrl = collectionMetaUrl({
          spaceUrl: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId }),
          collectionId
        })
        const result = await invoke({
          ctx,
          signer: state.alice.signer,
          url: metaUrl,
          method: 'PUT',
          json: { id: collectionId, name: 'Written By The Controller' }
        })
        assert.ok(
          result.status === 200 || result.status === 201,
          `expected the controller's own PUT to succeed, got ${result.status}`
        )
        const after = await state.alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.data.name, 'Written By The Controller')
      }
    },
    {
      id: 'container-rule.collection-meta-put-delegated-space-target',
      name: '[delegated] PUT /space/:s/:c/meta is authorized by an exact-target grant on the Space URL',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Collection Metadata (delegated)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const collectionId = ctx.generateId()
        const metaUrl = collectionMetaUrl({ spaceUrl, collectionId })
        const capability = await delegateInSpace({
          ctx,
          state,
          spaceId,
          invocationTarget: spaceUrl,
          allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
        })
        const result = await invoke({
          ctx,
          signer: state.aliceDelegatedApp.signer,
          url: metaUrl,
          method: 'PUT',
          capability,
          json: { id: collectionId, name: 'Written By A Delegate' }
        })
        assert.ok(
          result.status === 200 || result.status === 201,
          'the second container-rule exception must be honored, got ' +
            result.status
        )
        const after = await state.alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.data.name, 'Written By A Delegate')
      }
    },
    {
      id: 'container-rule.collection-meta-put-delegated-collection-target',
      name: '[delegated] PUT /space/:s/:c/meta under a grant on the Collection URL is refused (404)',
      specRefs: [CONTAINER_RULE],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Collection Metadata (collection target)'
        })
        const collectionId = ctx.generateId()
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        await state.alice.rootClient.request({
          url: spaceUrl,
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: 'Unchanged Collection' }
        })
        const metaUrl = collectionMetaUrl({ spaceUrl, collectionId })
        // A Collection-level data grant, the shape an app holds. The second
        // exception names only a grant on the Space URL, so this grant does
        // not authorize the Metadata write.
        const capability = await delegateInSpace({
          ctx,
          state,
          spaceId,
          invocationTarget: collectionUrl({ spaceUrl, collectionId }),
          allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
        })
        const result = await invoke({
          ctx,
          signer: state.aliceDelegatedApp.signer,
          url: metaUrl,
          method: 'PUT',
          capability,
          json: { id: collectionId, name: 'Rewritten By A Delegate' }
        })
        assertRefused({
          result,
          message: 'a delegated PUT under a Collection-URL grant'
        })
        // Nothing was written: the stored name is intact.
        const after = await state.alice.rootClient.request({
          url: metaUrl,
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.name, 'Unchanged Collection')
      }
    },
    {
      id: 'container-rule.collection-create-delegable',
      name: '[delegated] POST /space/:s/ still creates a Collection under an exact-target Space grant',
      specRefs: [
        CONTAINER_RULE,
        'https://w3id.org/pws#create-collection-add-collection-to-a-space-operation'
      ],
      run: async (ctx, state) => {
        const spaceId = await provisionSpace({
          ctx,
          state,
          name: 'Container Rule -- Create Collection (delegated)'
        })
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const collectionId = ctx.generateId()
        const capability = await delegateInSpace({
          ctx,
          state,
          spaceId,
          invocationTarget: spaceUrl,
          allowedActions: ['POST']
        })
        const result = await invoke({
          ctx,
          signer: state.aliceDelegatedApp.signer,
          url: spaceUrl,
          method: 'POST',
          capability,
          json: { id: collectionId, name: 'Created By A Delegate' }
        })
        assert.equal(
          result.status,
          201,
          'Create Collection is unaffected by the container rule'
        )
        const after = await state.alice.rootClient.request({
          url: collectionMetaUrl({ spaceUrl, collectionId }),
          method: 'GET'
        })
        assert.equal(after.status, 200)
        assert.equal(after.data.name, 'Created By A Delegate')
      }
    }
  ]
}
