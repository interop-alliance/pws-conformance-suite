/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level WasClient: Spaces & Collections.
 *
 * Drives the published `@interop/was-client` against a live server over the
 * HTTP contract, rather than the low-level `ZcapClient` used by the `*-api`
 * suites. This is where the client's own integration coverage lives, so the
 * client repo can stay free of any dependency on this server.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'
import {
  checkBackendsMember,
  withoutCreatingStamp,
  withoutReplicas,
  withoutWriteStamp
} from '../helpers.js'

import { NotFoundError } from '@interop/was-client'
import type { Space } from '@interop/was-client'

interface State {
  alice: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
  space: Space
}

export const clientSpaces: Suite<State> = {
  id: 'client-spaces',
  name: 'WasClient — Spaces & Collections',

  setup: async ctx => {
    // Shallow-clone the shared actor so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const createdSpaces: Space[] = []

    // Creates a space via the high-level client and registers it for teardown.
    const newSpace = async (name: string): Promise<Space> => {
      const space = await ctx.provisionSpace({ was: alice.was, name })
      createdSpaces.push(space)
      return space
    }

    return { alice, createdSpaces, newSpace, space: undefined as any }
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

  groups: [
    {
      name: 'collections',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Collections Space')
      }
    },
    {
      name: 'backend & quota',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Backend & Quota Space')
      }
    },
    {
      name: 'space backends & quotas',
      setup: async (ctx, state) => {
        state.space = await state.newSpace('Backends & Quotas Space')
        const collection = await state.space.createCollection({ id: 'docs' })
        await collection.add({ hello: 'world' })
      }
    }
  ],

  tests: [
    {
      id: 'spaces.create-and-read',
      name: 'creates a space and reads it back',
      group: 'spaces',
      specRefs: [
        'https://w3id.org/pws#create-space-operation',
        'https://w3id.org/pws#read-space-operation'
      ],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice, newSpace } = state
        const space = await newSpace('Home')
        const description = await space.describe()
        const rest = await checkBackendsMember({
          serverUrl,
          metadata: description,
          readListing: () => space.backends()
        })
        // A Space is a container, so its `url` carries the canonical
        // trailing slash (spec "Space Metadata Data Model"). The write stamp
        // members are checked for shape, not exact value.
        assert.deepStrictEqual(
          withoutCreatedBy(withoutReplicas(withoutWriteStamp(rest))),
          {
            id: space.id,
            type: ['Space'],
            name: 'Home',
            controller: alice.did,
            url: `/space/${space.id}/`,
            linkset: `/space/${space.id}/linkset`
          }
        )
      }
    },
    {
      id: 'spaces.describe-missing-null',
      name: 'returns null when describing a missing space (404 conflation)',
      group: 'spaces',
      specRefs: ['https://w3id.org/pws#read-space-operation'],
      run: async (ctx, state) => {
        const { alice } = state
        const missing = await alice.was.space('no-such-space').describe()
        assert.equal(missing, null)
      }
    },
    {
      id: 'spaces.delete-idempotent',
      name: 'deletes a space and is idempotent',
      group: 'spaces',
      specRefs: ['https://w3id.org/pws#delete-space-operation'],
      run: async (ctx, state) => {
        const { newSpace } = state
        const space = await newSpace('Disposable')
        await space.delete()
        assert.equal(await space.describe(), null)
        // Deleting again must not throw.
        await space.delete()
      }
    },
    {
      id: 'spaces.configure-update',
      name: 'configures (updates) an existing space',
      group: 'spaces',
      specRefs: ['https://w3id.org/pws#update-or-create-by-id-space-operation'],
      run: async (ctx, state) => {
        const { newSpace } = state
        const space = await newSpace('Original')
        const updated = await space.configure({ name: 'Renamed' })
        assert.equal(updated.description.name, 'Renamed')
        const reread = await space.describe()
        assert.equal(reread?.name, 'Renamed')
      }
    },
    {
      id: 'spaces.list-includes-created',
      name: 'listSpaces includes a created space',
      group: 'spaces',
      specRefs: ['https://w3id.org/pws#list-spaces-operation'],
      run: async (ctx, state) => {
        const { alice, newSpace } = state
        // A persistent external server may hold other spaces for Alice from
        // earlier runs, so assert containment rather than exact contents.
        const space = await newSpace('Listed Space')
        const listing = await alice.was.listSpaces()
        assert.equal(listing.url, '/spaces/')
        assert.equal(listing.totalItems, listing.items.length)
        assert.deepStrictEqual(
          listing.items.find((item: { id: string }) => item.id === space.id),
          {
            id: space.id,
            type: ['Space'],
            name: 'Listed Space',
            url: `/space/${space.id}/`
          }
        )
      }
    },
    {
      id: 'spaces.list-items-carry-type',
      name: "each listSpaces item carries its Space's Metadata type",
      group: 'spaces',
      specRefs: ['https://w3id.org/pws#list-spaces-operation'],
      run: async (ctx, state) => {
        const { alice, newSpace } = state
        await newSpace('Typed Listing Space')
        const listing = await alice.was.listSpaces()
        assert.ok(listing.items.length >= 1)
        // Every listed item, auxiliary Spaces included, carries the same
        // `type` array its Space Metadata object does.
        for (const item of listing.items) {
          assert.ok(
            Array.isArray(item.type),
            `listed Space ${item.id} carries a type array`
          )
          const metadata = await alice.was.space(item.id).describe()
          // A Space deleted between the listing and this read is skipped.
          if (metadata === null) {
            continue
          }
          assert.deepStrictEqual(item.type, metadata.type)
        }
      }
    },
    {
      id: 'collections.create-and-describe',
      name: 'creates a collection by id and reads its Collection Metadata object',
      group: 'collections',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-collection-operation',
        'https://w3id.org/pws#read-collection-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { withoutCreatedBy } = ctx
        const { space } = state
        const collection = await space.createCollection({
          id: 'credentials',
          name: 'Verifiable Credentials'
        })
        assert.equal(collection.id, 'credentials')
        // A Collection is a container too, so its `url` also carries the
        // canonical trailing slash. `createdAt` and the write stamp
        // (`updatedAt`, `updatedAtCounter`, `originId`) are dynamic, so they
        // are checked for shape, not exact value. `etag` is a client-side
        // convenience the wire body never carries (spec: the validator is
        // surfaced only as the `ETag` header).
        const described = withoutCreatingStamp(
          withoutWriteStamp(withoutCreatedBy(await collection.describe()))
        )
        const { createdAt, etag: _etag, ...rest } = described
        assert.match(createdAt as string, /^\d{4}-\d{2}-\d{2}T/)
        assert.deepStrictEqual(rest, {
          id: 'credentials',
          type: ['Collection'],
          name: 'Verifiable Credentials',
          backend: { id: 'default' },
          url: `/space/${space.id}/credentials/`,
          linkset: `/space/${space.id}/credentials/linkset`
        })
      }
    },
    {
      id: 'collections.list-in-space',
      name: 'lists collections in a space',
      group: 'collections',
      specRefs: ['https://w3id.org/pws#list-all-collections-operation'],
      run: async (ctx, state) => {
        const { space } = state
        const listing = await space.collections()
        assert.ok(listing)
        assert.ok(listing.totalItems >= 1)
        assert.ok(listing.items.some(item => item.id === 'credentials'))
      }
    },
    {
      id: 'collections.add-missing-space-not-found',
      name: 'throws NotFoundError adding to a collection in a missing space',
      group: 'collections',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const orphan = alice.was.space('missing-space').collection('c')
        await assert.rejects(
          orphan.add({ hello: 'world' }),
          (err: unknown) => err instanceof NotFoundError
        )
      }
    },
    {
      id: 'backend-quota.read-collection-backend',
      name: 'reads the backend a collection is stored on',
      group: 'backend & quota',
      optional: true,
      specRefs: ['https://w3id.org/pws#collection-backend-selected'],
      run: async (ctx, state) => {
        const { space } = state
        const collection = await space.createCollection({ id: 'backend-probe' })
        const backend = await collection.backend()
        assert.ok(backend)
        // The display name is server-specific (e.g. 'Server Filesystem' or
        // 'Server PostgreSQL'); the suite runs against any conforming server.
        const { name, ...rest } = backend
        assert.ok(typeof name === 'string' && name.length > 0)
        assert.deepStrictEqual(rest, {
          id: 'default',
          managedBy: 'server',
          persistence: 'durable'
        })
      }
    },
    {
      id: 'backend-quota.missing-collection-backend-null',
      name: 'returns null reading the backend of a missing collection (404 conflation)',
      group: 'backend & quota',
      optional: true,
      specRefs: ['https://w3id.org/pws#collection-backend-selected'],
      run: async (ctx, state) => {
        const { space } = state
        const missing = space.collection('no-such-collection')
        assert.equal(await missing.backend(), null)
      }
    },
    {
      id: 'backend-quota.read-collection-quota',
      name: "reads a collection's storage quota, scoped to its backend",
      group: 'backend & quota',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space } = state
        const collection = await space.createCollection({ id: 'quota-probe' })
        await collection.add({ hello: 'world' })
        const usage = await collection.quota()
        assert.ok(usage)
        // The report names the backend by an id from the Space's backends
        // listing. A server may list its default backend under `default`
        // alone or also under a fixed id of its own, and report either.
        const backends = await space.backends()
        assert.ok(backends)
        assert.ok(
          backends.some(backend => backend.id === usage.id),
          `backend ${usage.id} is not in the Space's backends listing`
        )
        assert.equal(usage.managedBy, 'server')
        assert.equal(usage.state, 'ok')
        assert.ok(usage.usageBytes > 0, 'expected non-zero collection usage')
        // The default filesystem backend has no configured capacity (unlimited).
        assert.deepStrictEqual(usage.limit, { isUnlimited: true })
        assert.deepStrictEqual(usage.restrictedActions, [])
        assert.match(usage.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
        // The per-collection report is the whole report -- no nested breakdown.
        assert.equal(usage.usageByCollection, undefined)
      }
    },
    {
      id: 'backend-quota.missing-collection-quota-null',
      name: 'returns null reading the quota of a missing collection (404 conflation)',
      group: 'backend & quota',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space } = state
        const missing = space.collection('no-such-collection')
        assert.equal(await missing.quota(), null)
      }
    },
    {
      id: 'space-backends.list-backends',
      name: 'lists the storage backends available in the space',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#space-backends-available'],
      run: async (ctx, state) => {
        const { space } = state
        const backends = await space.backends()
        assert.ok(backends)
        // A fresh Space lists only the server's own backends: the `default`
        // entry and, on a server that runs several, each under a fixed id.
        // How many there are and their display names (e.g. 'Server
        // Filesystem' or 'Server PostgreSQL') are server-specific; the suite
        // runs against any conforming server.
        assert.ok(backends.length >= 1)
        assert.ok(backends.some(backend => backend.id === 'default'))
        for (const backend of backends) {
          const { id, name, ...rest } = backend
          assert.ok(typeof id === 'string' && id.length > 0)
          assert.ok(typeof name === 'string' && name.length > 0)
          assert.deepStrictEqual(rest, {
            managedBy: 'server',
            persistence: 'durable'
          })
        }
      }
    },
    {
      id: 'space-backends.missing-space-backends-null',
      name: 'returns null listing backends of a missing space (404 conflation)',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#space-backends-available'],
      run: async (ctx, state) => {
        const { alice } = state
        assert.equal(await alice.was.space('no-such-space').backends(), null)
      }
    },
    {
      id: 'space-backends.read-space-quotas',
      name: 'reads the space storage quota report, grouped by backend',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space } = state
        const report = await space.quotas()
        assert.ok(report)
        assert.match(report.respondedAt, /^\d{4}-\d{2}-\d{2}T/)
        // One entry per server backend holding this Space's data. The Space
        // has written to its default backend only, and the entry names it by
        // an id from the backends listing (`default`, or a server's own fixed
        // id for it).
        assert.equal(report.backends.length, 1)
        const entry = report.backends[0]
        assert.ok(entry)
        const backends = await space.backends()
        assert.ok(backends)
        assert.ok(
          backends.some(backend => backend.id === entry.id),
          `backend ${entry.id} is not in the Space's backends listing`
        )
        // Server-specific display name; just require one.
        assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
        assert.equal(entry.managedBy, 'server')
        assert.equal(entry.state, 'ok')
        assert.ok(entry.usageBytes > 0, 'expected non-zero usage')
        // The default filesystem backend has no configured capacity (unlimited).
        assert.deepStrictEqual(entry.limit, { isUnlimited: true })
        assert.deepStrictEqual(entry.restrictedActions, [])
        assert.match(entry.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
        // The per-Collection breakdown is opt-in (spec `?include=collections`), so
        // a bare report omits it.
        assert.equal(entry.usageByCollection, undefined)
      }
    },
    {
      id: 'space-backends.include-collections-breakdown',
      name: 'reads the per-collection breakdown with includeCollections',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space } = state
        const report = await space.quotas({ includeCollections: true })
        assert.ok(report)
        const entry = report.backends[0]
        assert.ok(entry)
        // With the opt-in, the space-level report carries a per-collection breakdown.
        const breakdown = entry.usageByCollection
        assert.ok(breakdown, 'expected a usageByCollection breakdown')
        assert.ok(
          breakdown.some(item => item.id === 'docs'),
          'expected the docs collection in the breakdown'
        )
      }
    },
    {
      id: 'space-backends.missing-space-quotas-null',
      name: 'returns null reading quotas of a missing space (404 conflation)',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { alice } = state
        assert.equal(await alice.was.space('no-such-space').quotas(), null)
      }
    }
  ]
}
