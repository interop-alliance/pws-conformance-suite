/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * PWS conformance tests -- `createdBy` provenance, gated on the `created-by`
 * feature token.
 *
 * `createdBy` is the list of DIDs the creating write was delegated through. A
 * create under a root invocation lists the invoker alone. A create under a
 * delegated capability lists the controller of each delegated capability in
 * the chain, in delegation order, with the invoker last. The Space controller
 * holds the root capability, which is not a delegated one, so it is left out
 * of a delegated create's list. The creating write records the list and every
 * later write keeps it.
 *
 * The spec text for the list is tracked in
 * https://github.com/w3c-ccg/portable-web-spaces-spec/issues/98, and the
 * cases gain their `specRefs` when it lands.
 *
 * `setup()` reads the service description once, and every case skips when the
 * `created-by` token is absent. A Resource's `createdBy` is read from its
 * Metadata object when the server advertises `metadata`, and from the create's
 * response body otherwise. A case skips when neither carries it. The changes
 * feed case reads the feed alone, so it needs neither.
 */
import {
  collectionMetaUrl,
  collectionQueryUrl,
  collectionUrl,
  resourceMetaUrl,
  resourceUrl,
  rootCapabilityId,
  spaceMetaUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import type { ISigner } from '@interop/data-integrity-core'
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite, TestContext } from '../harness/types.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  bob: any
  spaceUrl: string
  collectionId: string
  createdBySupported: boolean
  metadataSupported: boolean
  changesSupported: boolean
}

/**
 * Skips the test unless the server advertises the `created-by` token.
 *
 * @param ctx {TestContext}
 * @param state {State}
 */
function requireCreatedBy(ctx: TestContext, state: State): void {
  if (!state.createdBySupported) {
    ctx.skip('the service description does not advertise created-by')
  }
}

/**
 * Delegates `PUT` on the suite's Collection from Alice to her app. With
 * `subDelegate`, the app delegates the grant on to Bob, and that second
 * capability is returned.
 *
 * @param options {object}
 * @param options.ctx {TestContext}
 * @param options.state {State}
 * @param [options.subDelegate] {boolean}
 * @returns {Promise<any>}   the capability to invoke
 */
async function delegateCollectionWrite({
  ctx,
  state,
  subDelegate = false
}: {
  ctx: TestContext
  state: State
  subDelegate?: boolean
}): Promise<any> {
  const { alice, aliceDelegatedApp, bob, spaceUrl, collectionId } = state
  const invocationTarget = collectionUrl({ spaceUrl, collectionId })
  const appCapability = await alice.rootClient.delegate({
    capability: rootCapabilityId(spaceUrl),
    allowedActions: ['PUT'],
    invocationTarget,
    controller: aliceDelegatedApp.did
  })
  if (!subDelegate) {
    return appCapability
  }
  return ctx.zcapClient({ signer: aliceDelegatedApp.signer }).delegate({
    capability: appCapability,
    allowedActions: ['PUT'],
    invocationTarget,
    controller: bob.did
  })
}

/** Who creates a Resource in the suite's Collection, and under what grant. */
interface CreateOptions {
  ctx: TestContext
  state: State
  /** The invoking signer. */
  signer: ISigner
  /** The delegated capability to invoke. Absent for a root invocation. */
  capability?: any
}

/**
 * Creates a fresh Resource in the suite's Collection, signing as `signer`
 * (under `capability` when given, else the signer's root authority). A create
 * answers `201`, or `204` with no body.
 *
 * @param options {CreateOptions}
 * @returns {Promise<{ resourceId: string; written: unknown }>}   the new id,
 *   with the `createdBy` the response body carried, if any
 */
async function putResource({
  ctx,
  state,
  signer,
  capability
}: CreateOptions): Promise<{ resourceId: string; written: unknown }> {
  const { spaceUrl, collectionId } = state
  const resourceId = ctx.generateId()
  const response = await ctx.zcapClient({ signer }).request({
    url: resourceUrl({ spaceUrl, collectionId, resourceId }),
    method: 'PUT',
    action: 'PUT',
    json: { id: resourceId },
    ...(capability && { capability })
  })
  assert.ok(
    response.status === 201 || response.status === 204,
    `expected 201 or 204, got ${response.status}`
  )
  return { resourceId, written: (response.data as any)?.createdBy }
}

/**
 * Creates a fresh Resource, as `putResource` does, and returns its id with the
 * `createdBy` the server recorded. Skips the test when the server serves a
 * Resource's `createdBy` nowhere this helper can read it.
 *
 * @param options {CreateOptions}
 * @returns {Promise<{ resourceId: string; createdBy: unknown }>}
 */
async function createResource(
  options: CreateOptions
): Promise<{ resourceId: string; createdBy: unknown }> {
  const { ctx, state } = options
  const { resourceId, written } = await putResource(options)
  if (state.metadataSupported) {
    return { resourceId, createdBy: await readCreatedBy(state, resourceId) }
  }
  if (written === undefined) {
    ctx.skip(
      'the server serves neither Resource Metadata nor a `createdBy` in ' +
        'the write response'
    )
  }
  return { resourceId, createdBy: written }
}

/**
 * Reads a Resource's `createdBy` from its Metadata object, as the Space
 * controller.
 *
 * @param state {State}
 * @param resourceId {string}
 * @returns {Promise<unknown>}
 */
async function readCreatedBy(
  state: State,
  resourceId: string
): Promise<unknown> {
  const { alice, spaceUrl, collectionId } = state
  const response = await alice.rootClient.request({
    url: resourceMetaUrl({ spaceUrl, collectionId, resourceId }),
    method: 'GET'
  })
  assert.equal(response.status, 200)
  return response.data.createdBy
}

export const createdByApi: Suite<State> = {
  id: 'created-by-api',
  name: 'Creation provenance (createdBy)',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const aliceDelegatedApp: any = { ...ctx.actors.aliceDelegatedApp }
    const bob: any = { ...ctx.actors.bob }
    const collectionId = 'provenance'
    const spaceId = ctx.generateId()
    const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })

    await ctx.createSpace({
      spaceDescription: {
        id: spaceId,
        name: "Alice's Creation Provenance Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Creation Provenance' }
    })

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    return {
      alice,
      aliceDelegatedApp,
      bob,
      spaceUrl,
      collectionId,
      createdBySupported: features.includes('created-by'),
      metadataSupported: features.includes('metadata'),
      changesSupported: features.includes('changes-query')
    }
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
      id: 'created-by.root-space',
      name: '[root] a Space created under a root invocation lists the invoker alone',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { alice, spaceUrl } = state
        const response = await alice.rootClient.request({
          url: spaceMetaUrl({ spaceUrl }),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        // A create the provisioning policy granted has no verified invoker,
        // so a Space provisioned with the onboarding token records none.
        if (ctx.onboardingToken && response.data.createdBy === undefined) {
          ctx.skip(
            'a Space provisioned with the onboarding token records no ' +
              '`createdBy`'
          )
        }
        assert.deepStrictEqual(response.data.createdBy, [alice.did])
      }
    },
    {
      id: 'created-by.root-collection',
      name: '[root] a Collection created under a root invocation lists the invoker alone',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { alice, spaceUrl, collectionId } = state
        const response = await alice.rootClient.request({
          url: collectionMetaUrl({ spaceUrl, collectionId }),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.deepStrictEqual(response.data.createdBy, [alice.did])
      }
    },
    {
      id: 'created-by.root-resource',
      name: '[root] a Resource created under a root invocation lists the invoker alone',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { alice } = state
        const { createdBy } = await createResource({
          ctx,
          state,
          signer: alice.signer
        })
        assert.deepStrictEqual(createdBy, [alice.did])
      }
    },
    {
      id: 'created-by.one-link-delegation',
      name: '[delegated] a create under a one-link delegation lists the delegatee alone',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { aliceDelegatedApp } = state
        const { createdBy } = await createResource({
          ctx,
          state,
          signer: aliceDelegatedApp.signer,
          capability: await delegateCollectionWrite({ ctx, state })
        })
        assert.deepStrictEqual(createdBy, [aliceDelegatedApp.did])
      }
    },
    {
      id: 'created-by.two-link-delegation',
      name:
        '[delegated] a create under a two-link chain lists both delegatees ' +
        'in delegation order, without the Space controller',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { aliceDelegatedApp, bob } = state
        const { createdBy } = await createResource({
          ctx,
          state,
          signer: bob.signer,
          capability: await delegateCollectionWrite({
            ctx,
            state,
            subDelegate: true
          })
        })
        // Alice controls the root capability, so she is not listed. Bob
        // invoked, so he is last.
        assert.deepStrictEqual(createdBy, [aliceDelegatedApp.did, bob.did])
      }
    },
    {
      id: 'created-by.unchanged-after-later-write',
      name: '[delegated] a later write by a different invoker leaves `createdBy` unchanged',
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { alice, aliceDelegatedApp, spaceUrl, collectionId } = state
        if (!state.metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const { resourceId, createdBy } = await createResource({
          ctx,
          state,
          signer: aliceDelegatedApp.signer,
          capability: await delegateCollectionWrite({ ctx, state })
        })
        assert.deepStrictEqual(createdBy, [aliceDelegatedApp.did])

        const update = await alice.rootClient.request({
          url: resourceUrl({ spaceUrl, collectionId, resourceId }),
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId, updated: true }
        })
        assert.ok(
          update.status === 200 || update.status === 204,
          `expected 200 or 204, got ${update.status}`
        )
        assert.deepStrictEqual(await readCreatedBy(state, resourceId), [
          aliceDelegatedApp.did
        ])
      }
    },
    {
      id: 'created-by.changes-feed-document',
      name: '[delegated] a `resource` document in the changes feed carries the same list',
      // Optional: the spec makes surfacing `createdBy` in the feed a SHOULD.
      optional: true,
      run: async (ctx, state) => {
        requireCreatedBy(ctx, state)
        const { alice, aliceDelegatedApp, spaceUrl, collectionId } = state
        if (!state.changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const { resourceId } = await putResource({
          ctx,
          state,
          signer: aliceDelegatedApp.signer,
          capability: await delegateCollectionWrite({ ctx, state })
        })

        const changes = await alice.rootClient.request({
          url: collectionQueryUrl({ spaceUrl, collectionId }),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 1000 }
        })
        assert.equal(changes.status, 200)
        const document = changes.data.documents.find(
          (doc: any) => doc.kind === 'resource' && doc.id === resourceId
        )
        assert.ok(document, 'expected the created resource in the changes feed')
        assert.deepStrictEqual(document.createdBy, [aliceDelegatedApp.did])
      }
    }
  ]
}
