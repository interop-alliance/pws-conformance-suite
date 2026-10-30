/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level PwsClient: Delegation.
 *
 * Exercises the client's grant / `fromCapability` round-trip against a live
 * server: Alice delegates access to Bob, who rebuilds a handle from the signed
 * capability and reads (but cannot write beyond the grant).
 */
import { Space, Resource } from '@interop/pws-client'

import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
}

export const clientDelegation: Suite<State> = {
  id: 'client-delegation',
  name: 'PwsClient -- Delegation',

  setup: async ctx => {
    // Shallow-clone the shared actors so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    const createdSpaces: Space[] = []

    /**
     * Creates a space owned by Alice and registers it for teardown.
     *
     * @param name {string}
     * @returns {Promise<Space>}
     */
    async function newSpace(name: string): Promise<Space> {
      const space = await ctx.provisionSpace({ pws: alice.pws, name })
      createdSpaces.push(space)
      return space
    }

    return { alice, bob, createdSpaces, newSpace }
  },

  teardown: async (ctx, state) => {
    for (const space of state.createdSpaces) {
      try {
        await space.delete()
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  tests: [
    {
      id: 'delegation.bob-no-grant',
      name: 'bob cannot see an alice space without a grant',
      specRefs: [
        'https://w3id.org/pws/authz-profile#delegation',
        'https://w3id.org/pws#read-space-operation'
      ],
      run: async (ctx, state) => {
        const { newSpace, bob } = state
        const space = await newSpace('Private')
        const seenByBob = await bob.pws.spaceAt(space.url).describe()
        assert.equal(seenByBob, null)
      }
    },
    {
      id: 'delegation.grant-read-space',
      name: 'grants read on a space; recipient reads via fromCapability',
      specRefs: [
        'https://w3id.org/pws/authz-profile#delegation',
        'https://w3id.org/pws#read-space-operation'
      ],
      run: async (ctx, state) => {
        const { newSpace, bob } = state
        const space = await newSpace('Shared Space')
        const zcap = await space.grant({ to: bob.did, actions: ['GET'] })

        const handle = bob.pws.fromCapability(zcap)
        assert.ok(handle instanceof Space)
        const description = await handle.describe()
        assert.equal(description?.name, 'Shared Space')
      }
    },
    {
      id: 'delegation.grant-read-resource',
      name: 'grants read on a resource; recipient reads but cannot write',
      specRefs: [
        'https://w3id.org/pws/authz-profile#delegation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { newSpace, bob } = state
        const space = await newSpace('Doc Space')
        const collection = await space.createCollection({ id: 'docs' })
        const added = await collection.add({ secret: 'value' })

        // Lowercase action input is normalized to uppercase in the signed zcap,
        // so it still validates against the server (which expects 'GET').
        const zcap = await collection.grant({
          to: bob.did,
          actions: ['get'],
          target: added.url
        })
        assert.deepStrictEqual(zcap.allowedAction, ['GET'])

        const handle = bob.pws.fromCapability(zcap)
        assert.ok(handle instanceof Resource)
        assert.equal(((await handle.get()) as any).secret, 'value')

        // The grant is read-only; a write must be denied.
        await assert.rejects(handle.put({ secret: 'tampered' }))
      }
    }
  ]
}
