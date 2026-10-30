/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level WasClient: Export / Import.
 *
 * Exercises the client's whole-space tar export and import against a live
 * server: export a populated space, then import the archive into a fresh one.
 */
import type { Space } from '@interop/was-client'
import { resourceUrl } from '@interop/was-client/paths'

import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
}

export const clientExportImport: Suite<State> = {
  id: 'client-export-import',
  name: 'WasClient — Export / Import',

  setup: async ctx => {
    // Shallow-clone the shared actor so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const createdSpaces: Space[] = []

    /**
     * Creates a space owned by Alice and registers it for teardown.
     *
     * @param name {string}
     * @returns {Promise<Space>}
     */
    async function newSpace(name: string): Promise<Space> {
      const space = await ctx.provisionSpace({ was: alice.was, name })
      createdSpaces.push(space)
      return space
    }

    return { alice, createdSpaces, newSpace }
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
      id: 'export-import.round-trip',
      name: 'exports a space to a tar archive and imports it into another',
      specRefs: ['https://w3id.org/pws#data-portability'],
      run: async (ctx, state) => {
        const { newSpace, alice } = state
        const source = await newSpace('Export Source')
        const collection = await source.createCollection({
          id: 'notes',
          name: 'Notes'
        })
        await collection.put('first', { body: 'one' })
        await collection.put('second', { body: 'two' })
        // Make the collection world-readable so we can verify the policy survives
        // the export/import round-trip.
        await alice.was.request({
          url: `${source.url}notes/policy`,
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })

        const archive = await source.export()
        assert.ok(archive instanceof Uint8Array)
        assert.ok(archive.byteLength > 0)

        const target = await newSpace('Import Target')
        const stats = await target.import(archive)
        assert.ok(stats.collectionsCreated >= 1)
        assert.ok(stats.resourcesCreated >= 2)
        assert.ok(stats.policiesCreated >= 1)

        const imported = (await target.collection('notes').get('first')) as any
        assert.equal(imported.body, 'one')

        // The PublicCanRead policy round-tripped: an anonymous GET of the imported
        // resource in the target space succeeds.
        const anonResponse = await fetch(
          resourceUrl({
            spaceUrl: target.url,
            collectionId: 'notes',
            resourceId: 'first'
          })
        )
        assert.equal(anonResponse.status, 200)
        const anonBody = (await anonResponse.json()) as { body: string }
        assert.equal(anonBody.body, 'one')
      }
    }
  ]
}
