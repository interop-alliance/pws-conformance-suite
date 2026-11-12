/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level PwsClient: Spaces & Collections.
 *
 * Drives the published `@interop/pws-client` against a live server over the
 * HTTP contract, rather than the low-level `ZcapClient` used by the `*-api`
 * suites. This is where the client's own integration coverage lives, so the
 * client repo can stay free of any dependency on this server.
 */
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'
import {
  assertResolvesTo,
  checkBackendsMember,
  withoutContainerUrls,
  withoutCreatingStamp,
  withoutReplicas,
  withoutWriteStamp
} from '../helpers.js'

import { NotFoundError } from '@interop/pws-client'
import type {
  BackendDescriptor,
  BackendUsage,
  Space
} from '@interop/pws-client'
import {
  collectionLinksetUrl,
  collectionMetaUrl,
  collectionUrl,
  spaceLinksetUrl,
  spaceMetaUrl,
  spacesRepositoryUrl
} from '@interop/pws-client/paths'

interface State {
  alice: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
  space: Space
  /** Whether the server advertises the `backends` feature token. */
  backendsSupported: boolean
  /** Whether the server advertises the `quotas` feature token. */
  quotasSupported: boolean
}

/**
 * Asserts a Backend description object has the shape the spec defines (spec
 * "Backend Data Model"). Only `id` is required. `name`, `managedBy` and
 * `persistence` are optional, and `managedBy` and `persistence` take the
 * defaults `server` and `durable` when absent.
 *
 * @param backend {BackendDescriptor}
 */
function assertBackendDescriptor(backend: BackendDescriptor): void {
  assert.ok(
    typeof backend.id === 'string' && backend.id.length > 0,
    'a backend carries a non-empty `id`'
  )
  if (backend.name !== undefined) {
    assert.equal(typeof backend.name, 'string', '`name` must be a string')
  }
  if (backend.managedBy !== undefined) {
    assert.ok(
      ['server', 'external'].includes(backend.managedBy),
      `unexpected \`managedBy\` ${backend.managedBy}`
    )
  }
  if (backend.persistence !== undefined) {
    assert.ok(
      ['durable', 'volatile'].includes(backend.persistence),
      `unexpected \`persistence\` ${backend.persistence}`
    )
  }
}

/**
 * Asserts a quota report entry has the members the spec lists for it (spec
 * "Quotas"). The values a backend reports (its state, its limit, the actions
 * it restricts) are its own, so only their shape is checked. `name` comes from
 * the backend's description, where it is optional.
 *
 * @param entry {BackendUsage}
 */
function assertQuotaEntry(entry: BackendUsage): void {
  assert.ok(
    typeof entry.id === 'string' && entry.id.length > 0,
    'a quota entry carries a non-empty `id`'
  )
  if (entry.name !== undefined) {
    assert.equal(typeof entry.name, 'string', '`name` must be a string')
  }
  assert.ok(
    ['server', 'external'].includes(entry.managedBy),
    `unexpected \`managedBy\` ${entry.managedBy}`
  )
  assert.ok(
    ['ok', 'near-limit', 'over-quota', 'unreachable'].includes(entry.state),
    `unexpected \`state\` ${entry.state}`
  )
  assert.ok(
    Number.isInteger(entry.usageBytes) && entry.usageBytes >= 0,
    '`usageBytes` must be a non-negative integer'
  )
  assert.ok(
    entry.limit && typeof entry.limit === 'object',
    '`limit` must be an object'
  )
  assert.equal(typeof entry.limit.isUnlimited, 'boolean')
  if (!entry.limit.isUnlimited) {
    assert.ok(
      Number.isInteger(entry.limit.capacityBytes) &&
        (entry.limit.capacityBytes as number) >= 0,
      'a limited backend reports `capacityBytes`'
    )
  }
  assert.ok(
    Array.isArray(entry.restrictedActions),
    '`restrictedActions` must be an array'
  )
  for (const action of entry.restrictedActions) {
    assert.ok(
      ['GET', 'POST', 'PUT', 'DELETE'].includes(action),
      `unexpected restricted action ${action}`
    )
  }
  assert.match(entry.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
}

export const clientSpaces: Suite<State> = {
  id: 'client-spaces',
  name: 'PwsClient -- Spaces & Collections',

  setup: async ctx => {
    // Shallow-clone the shared actor so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const createdSpaces: Space[] = []

    // Creates a space via the high-level client and registers it for teardown.
    const newSpace = async (name: string): Promise<Space> => {
      const space = await ctx.provisionSpace({ pws: alice.pws, name })
      createdSpaces.push(space)
      return space
    }

    // Backends and quotas are OPTIONAL extensions, each advertised by its
    // own feature token (spec "Scope and Conformance Profiles").
    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })

    return {
      alice,
      createdSpaces,
      newSpace,
      space: undefined as any,
      backendsSupported: features.includes('backends'),
      quotasSupported: features.includes('quotas')
    }
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
        // trailing slash (spec "Space Metadata Data Model"). It and `linkset`
        // are resolved against the Metadata object's URL. The write stamp
        // members are checked for shape, not exact value.
        assert.deepStrictEqual(
          withoutCreatedBy(
            withoutReplicas(
              withoutWriteStamp(
                withoutContainerUrls({
                  value: rest,
                  base: spaceMetaUrl({ spaceUrl: space.url }),
                  containerUrl: space.url,
                  linksetUrl: spaceLinksetUrl({ spaceUrl: space.url })
                })
              )
            )
          ),
          {
            id: space.id,
            type: ['Space'],
            name: 'Home',
            controller: alice.did
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
        const missing = await alice.pws.space('no-such-space').describe()
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
        // The client follows every `next` link, and the `totalItems` it
        // reports is its own count, so neither is a server claim to check.
        const space = await newSpace('Listed Space')
        const listing = await alice.pws.listSpaces()
        const spacesUrl = spacesRepositoryUrl({ baseServerUrl: ctx.serverUrl })
        assertResolvesTo({
          value: listing.url,
          base: spacesUrl,
          expected: spacesUrl,
          label: 'the listing `url`'
        })
        const item = listing.items.find(
          (candidate: { id: string }) => candidate.id === space.id
        )
        assert.ok(item, 'the listing includes the created Space')
        // Each item MUST carry `id`, `url`, and `type` (spec "List Spaces
        // Operation"). Other members are not required, and `name`, when a
        // server lists it, is the Space's name.
        assert.deepStrictEqual(item.type, ['Space'])
        assertResolvesTo({
          value: item.url,
          base: spacesUrl,
          expected: space.url,
          label: 'the listed Space `url`'
        })
        if (item.name !== undefined) {
          assert.equal(item.name, 'Listed Space')
        }
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
        const listing = await alice.pws.listSpaces()
        assert.ok(listing.items.length >= 1)
        // Every listed item, auxiliary Spaces included, carries the same
        // `type` array its Space Metadata object does.
        for (const item of listing.items) {
          assert.ok(
            Array.isArray(item.type),
            `listed Space ${item.id} carries a type array`
          )
          const metadata = await alice.pws.space(item.id).describe()
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
        // canonical trailing slash. It and `linkset` are resolved against the
        // Metadata object's URL. The write stamp (`updatedAt`,
        // `updatedAtCounter`, `originId`) is dynamic, so it is checked for
        // shape, not exact value. `createdAt` is OPTIONAL and checked when
        // present. `etag` is a client-side convenience the wire body never
        // carries (spec: the validator is surfaced only as the `ETag` header).
        const described = withoutContainerUrls({
          value: withoutCreatingStamp(
            withoutWriteStamp(withoutCreatedBy(await collection.describe()))
          ),
          base: collectionMetaUrl({
            spaceUrl: space.url,
            collectionId: 'credentials'
          }),
          containerUrl: collectionUrl({
            spaceUrl: space.url,
            collectionId: 'credentials'
          }),
          linksetUrl: collectionLinksetUrl({
            spaceUrl: space.url,
            collectionId: 'credentials'
          })
        })
        const { createdAt, etag: _etag, backend, ...rest } = described
        if (createdAt !== undefined) {
          assert.match(createdAt as string, /^\d{4}-\d{2}-\d{2}T/)
        }
        // `backend` is OPTIONAL, and a Collection created without one has the
        // `default` backend (spec "Collection Metadata Data Model").
        if (backend !== undefined) {
          assert.deepStrictEqual(backend, { id: 'default' })
        }
        assert.deepStrictEqual(rest, {
          id: 'credentials',
          type: ['Collection'],
          name: 'Verifiable Credentials'
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
        const orphan = alice.pws.space('missing-space').collection('c')
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
        const { space, backendsSupported } = state
        if (!backendsSupported) {
          ctx.skip('the service description does not advertise backends')
        }
        const collection = await space.createCollection({ id: 'backend-probe' })
        const backend = await collection.backend()
        assert.ok(backend)
        // A Collection created without a `backend` has the `default` one
        // (spec "Collection Backend Selected"). The other members of its
        // description are optional, and their values are server-specific.
        assertBackendDescriptor(backend)
        assert.equal(backend.id, 'default')
      }
    },
    {
      id: 'backend-quota.missing-collection-backend-null',
      name: 'returns null reading the backend of a missing collection (404 conflation)',
      group: 'backend & quota',
      optional: true,
      specRefs: ['https://w3id.org/pws#collection-backend-selected'],
      run: async (ctx, state) => {
        const { space, backendsSupported } = state
        if (!backendsSupported) {
          ctx.skip('the service description does not advertise backends')
        }
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
        const { space, backendsSupported, quotasSupported } = state
        if (!quotasSupported) {
          ctx.skip('the service description does not advertise quotas')
        }
        const collection = await space.createCollection({ id: 'quota-probe' })
        await collection.add({ hello: 'world' })
        const usage = await collection.quota()
        assert.ok(usage)
        assertQuotaEntry(usage)
        assert.ok(usage.usageBytes > 0, 'expected non-zero collection usage')
        // On a server with pluggable backends, the report names the backend
        // by an id from the Space's backends listing, and carries that
        // backend's `managedBy` (`server` when the description omits it).
        if (backendsSupported) {
          const backends = await space.backends()
          assert.ok(backends)
          const listed = backends.find(backend => backend.id === usage.id)
          assert.ok(
            listed,
            `backend ${usage.id} is not in the Space's backends listing`
          )
          assert.equal(usage.managedBy, listed.managedBy ?? 'server')
        }
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
        const { space, quotasSupported } = state
        if (!quotasSupported) {
          ctx.skip('the service description does not advertise quotas')
        }
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
        const { space, backendsSupported } = state
        if (!backendsSupported) {
          ctx.skip('the service description does not advertise backends')
        }
        const backends = await space.backends()
        assert.ok(backends)
        // A Space with a Collection lists at least the backend that Collection
        // is on. `default` is only the conventional id of the server's
        // default backend, and how many backends a server runs, and how it
        // describes them, are server-specific.
        assert.ok(backends.length >= 1)
        for (const backend of backends) {
          assertBackendDescriptor(backend)
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
        const { alice, backendsSupported } = state
        if (!backendsSupported) {
          ctx.skip('the service description does not advertise backends')
        }
        assert.equal(await alice.pws.space('no-such-space').backends(), null)
      }
    },
    {
      id: 'space-backends.read-space-quotas',
      name: 'reads the space storage quota report, grouped by backend',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space, backendsSupported, quotasSupported } = state
        if (!quotasSupported) {
          ctx.skip('the service description does not advertise quotas')
        }
        const report = await space.quotas()
        assert.ok(report)
        assert.match(report.respondedAt, /^\d{4}-\d{2}-\d{2}T/)
        // One entry per backend. The spec does not say whether a backend that
        // holds none of this Space's data is listed, so only the entries'
        // shape is checked, plus non-zero usage somewhere, since the Space
        // has written a Resource.
        assert.ok(Array.isArray(report.backends))
        assert.ok(report.backends.length >= 1)
        for (const entry of report.backends) {
          assertQuotaEntry(entry)
          // The per-Collection breakdown is opt-in (spec
          // `?include=collections`), so a bare report omits it.
          assert.equal(entry.usageByCollection, undefined)
        }
        assert.ok(
          report.backends.some(entry => entry.usageBytes > 0),
          'expected non-zero usage'
        )
        // On a server with pluggable backends, each entry names a backend
        // from the Space's backends listing.
        if (backendsSupported) {
          const backends = await space.backends()
          assert.ok(backends)
          for (const entry of report.backends) {
            assert.ok(
              backends.some(backend => backend.id === entry.id),
              `backend ${entry.id} is not in the Space's backends listing`
            )
          }
        }
      }
    },
    {
      id: 'space-backends.include-collections-breakdown',
      name: 'reads the per-collection breakdown with includeCollections',
      group: 'space backends & quotas',
      optional: true,
      specRefs: ['https://w3id.org/pws#quotas'],
      run: async (ctx, state) => {
        const { space, quotasSupported } = state
        if (!quotasSupported) {
          ctx.skip('the service description does not advertise quotas')
        }
        const report = await space.quotas({ includeCollections: true })
        assert.ok(report)
        assert.ok(report.backends.length >= 1)
        // With the opt-in, each backend entry carries a per-collection
        // breakdown, and the `docs` collection appears in one of them.
        for (const entry of report.backends) {
          assert.ok(
            Array.isArray(entry.usageByCollection),
            `expected a usageByCollection breakdown on backend ${entry.id}`
          )
        }
        assert.ok(
          report.backends.some(entry =>
            entry.usageByCollection!.some(item => item.id === 'docs')
          ),
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
        const { alice, quotasSupported } = state
        if (!quotasSupported) {
          ctx.skip('the service description does not advertise quotas')
        }
        assert.equal(await alice.pws.space('no-such-space').quotas(), null)
      }
    }
  ]
}
