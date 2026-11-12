/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- write stamps and validators.
 *
 * The server stamps every write with a hybrid logical clock. Each versioned
 * record carries three members. `updatedAt` is an RFC 3339 timestamp at
 * millisecond precision. `updatedAtCounter` is a non-negative integer that
 * ticks when the millisecond did not advance. `originId` names the store that
 * minted the stamp. The triple `(updatedAt, updatedAtCounter, originId)` is
 * the record's order key, so a later write of the same record sorts strictly
 * after an earlier one.
 *
 * The stamp rides the Space, Collection, and Resource Metadata objects and the
 * change documents of the `changes` query feed. A Resource Metadata object
 * carries the content record's stamp at the top level. Once its metadata has
 * been written, it also carries the metadata record's own stamp in a nested
 * `meta` member.
 *
 * The `ETag` is a separate validator. Clients treat it as opaque, so these
 * tests compare it only for equality. It is a quoted strong validator, and it
 * moves on every write, including a write of an identical body.
 */
import {
  collectionMetaUrl,
  collectionQueryUrl,
  resourceMetaUrl,
  resourceUrl as resourceUrlOf,
  spaceMetaUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import {
  PWS_SPEC_IDENTIFIER,
  fetchServiceDescription,
  serviceFeatures
} from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'
import { assertWriteStamp } from '../helpers.js'

interface State {
  alice: any
  spaceId: string
  spaceUrl: string
  collectionId: string
  metadataSupported: boolean
  changesSupported: boolean
  spaceMetaUrl: string
  collectionMetaUrl: string
  resourceUrl: (id: string) => string
  resourceMetaUrl: (id: string) => string
  queryUrl: string
}

/** The three write-stamp members of a versioned record. */
interface WriteStamp {
  updatedAt: string
  updatedAtCounter: number
  originId: string
}

/**
 * Picks the three write-stamp members off a record and asserts they are
 * well-formed.
 *
 * @param record {any}   a Metadata object, a change document, or a nested `meta`
 * @returns {WriteStamp}
 */
function stampOf(record: any): WriteStamp {
  assert.ok(record && typeof record === 'object', 'expected a record object')
  const stamp = {
    updatedAt: record.updatedAt,
    updatedAtCounter: record.updatedAtCounter,
    originId: record.originId
  }
  assertWriteStamp(stamp)
  return stamp
}

/**
 * Compares two stamps by their order key `(Date.parse(updatedAt),
 * updatedAtCounter, originId)`.
 *
 * @param a {WriteStamp}
 * @param b {WriteStamp}
 * @returns {number}   negative, zero, or positive, like a sort comparator
 */
function compareStamps(a: WriteStamp, b: WriteStamp): number {
  const byTime = Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  if (byTime !== 0) {
    return byTime
  }
  const byCounter = a.updatedAtCounter - b.updatedAtCounter
  if (byCounter !== 0) {
    return byCounter
  }
  if (a.originId === b.originId) {
    return 0
  }
  return a.originId < b.originId ? -1 : 1
}

/**
 * Asserts a later write's stamp moved past an earlier one. It must differ in
 * `updatedAt` or `updatedAtCounter`, and its order key must sort strictly
 * after the earlier key.
 *
 * @param before {WriteStamp}   the stamp of the earlier write
 * @param after {WriteStamp}   the stamp of the later write
 */
function assertStampAdvanced(before: WriteStamp, after: WriteStamp): void {
  assert.ok(
    before.updatedAt !== after.updatedAt ||
      before.updatedAtCounter !== after.updatedAtCounter,
    `expected the second write to mint a new stamp, both were ` +
      `${JSON.stringify(after)}`
  )
  assert.ok(
    compareStamps(after, before) > 0,
    `expected ${JSON.stringify(after)} to sort after ${JSON.stringify(before)}`
  )
}

/**
 * Asserts a response carries a quoted strong `ETag` and returns it. The value
 * is opaque, so only its outer form is checked.
 *
 * @param response {any}   a `ZcapClient.request()` response
 * @param label {string}   names the request in the failure message
 * @returns {string}
 */
function strongEtagOf(response: any, label: string): string {
  const etag = response.headers.get('etag')
  assert.ok(etag, `expected an ETag on ${label}`)
  assert.ok(!etag.startsWith('W/'), `expected a strong ETag on ${label}`)
  assert.match(etag, /^"[^"]+"$/, `expected a quoted ETag on ${label}`)
  return etag
}

/**
 * Reads the `changes` feed of the suite Collection and returns the document
 * for one Resource.
 *
 * @param options {object}
 * @param options.alice {any}   the suite's root actor
 * @param options.queryUrl {string}   the Collection's query endpoint
 * @param options.resourceId {string}
 * @returns {Promise<any>}
 */
async function changeDocumentFor({
  alice,
  queryUrl,
  resourceId
}: {
  alice: any
  queryUrl: string
  resourceId: string
}): Promise<any> {
  const response = await alice.rootClient.request({
    url: queryUrl,
    method: 'POST',
    action: 'POST',
    json: { profile: 'changes', limit: 100 }
  })
  const document = response.data.documents.find(
    (doc: any) => doc.kind === 'resource' && doc.id === resourceId
  )
  assert.ok(document, `expected ${resourceId} in the changes feed`)
  return document
}

export const writeStampApi: Suite<State> = {
  id: 'write-stamp-api',
  name: 'Write stamps and validators',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const spaceId = ctx.generateId()
    const collectionId = 'stamps'
    const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    await ctx.createSpace({
      spaceDescription: {
        id: spaceId,
        name: "Alice's Write Stamp Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Write Stamps' }
    })

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })

    /** Absolute URL for a Resource in the suite Collection. */
    function resourceUrl(id: string): string {
      return resourceUrlOf({ spaceUrl, collectionId, resourceId: id })
    }

    function resourceMeta(id: string): string {
      return resourceMetaUrl({ spaceUrl, collectionId, resourceId: id })
    }

    return {
      alice,
      spaceId,
      spaceUrl,
      collectionId,
      metadataSupported: features.includes('metadata'),
      changesSupported: features.includes('changes-query'),
      spaceMetaUrl: spaceMetaUrl({ spaceUrl }),
      collectionMetaUrl: collectionMetaUrl({ spaceUrl, collectionId }),
      resourceUrl,
      resourceMetaUrl: resourceMeta,
      queryUrl: collectionQueryUrl({ spaceUrl, collectionId })
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
      id: 'write-stamp.space-metadata',
      name:
        '[root] the Space Metadata object carries a write stamp; an update ' +
        'mints a later one',
      specRefs: [
        'https://w3id.org/pws#space-metadata-data-model',
        'https://w3id.org/pws#update-or-create-by-id-space-operation'
      ],
      run: async (ctx, state) => {
        const { alice, spaceId, spaceMetaUrl } = state
        const before = await alice.rootClient.request({
          url: spaceMetaUrl,
          method: 'GET'
        })
        const first = stampOf(before.data)

        await alice.rootClient.request({
          url: spaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          json: {
            id: spaceId,
            name: 'Renamed Write Stamp Space',
            controller: alice.did
          }
        })
        const after = await alice.rootClient.request({
          url: spaceMetaUrl,
          method: 'GET'
        })
        assertStampAdvanced(first, stampOf(after.data))
      }
    },
    {
      id: 'write-stamp.collection-metadata',
      name:
        '[root] the Collection Metadata object carries a write stamp; an ' +
        'update mints a later one',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#update-or-create-by-id-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId, collectionMetaUrl, metadataSupported } =
          state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const before = await alice.rootClient.request({
          url: collectionMetaUrl,
          method: 'GET'
        })
        const first = stampOf(before.data)

        await alice.rootClient.request({
          url: collectionMetaUrl,
          method: 'PUT',
          action: 'PUT',
          json: { id: collectionId, name: 'Renamed Write Stamps' }
        })
        const after = await alice.rootClient.request({
          url: collectionMetaUrl,
          method: 'GET'
        })
        assertStampAdvanced(first, stampOf(after.data))
      }
    },
    {
      id: 'write-stamp.resource-metadata',
      name:
        '[root] the Resource Metadata object carries the content stamp; a ' +
        'metadata write adds a nested `meta` stamp and leaves it unchanged',
      specRefs: [
        'https://w3id.org/pws#resource-metadata-data-model',
        'https://w3id.org/pws#update-resource-metadata-operation'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })
        const before = await alice.rootClient.request({
          url: state.resourceMetaUrl(resourceId),
          method: 'GET'
        })
        const contentStamp = stampOf(before.data)

        const metaPut = await alice.rootClient.request({
          url: state.resourceMetaUrl(resourceId),
          method: 'PUT',
          action: 'PUT',
          json: { custom: { a: 1 } }
        })
        const after = await alice.rootClient.request({
          url: state.resourceMetaUrl(resourceId),
          method: 'GET'
        })
        // The metadata write did not write the content record.
        assert.deepStrictEqual(stampOf(after.data), contentStamp)
        stampOf(after.data.meta)
        assert.equal(
          typeof after.data.meta.generation,
          'string',
          'expected a string `meta.generation`'
        )
        assert.equal(
          after.headers.get('etag'),
          strongEtagOf(metaPut, 'the metadata write')
        )
      }
    },
    {
      id: 'write-stamp.change-document',
      name:
        '[root] a change document carries the same stamps as the Resource ' +
        'Metadata object; a tombstone carries a stamp',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#resource-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported, changesSupported, queryUrl } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId }
        })
        if (metadataSupported) {
          await alice.rootClient.request({
            url: state.resourceMetaUrl(resourceId),
            method: 'PUT',
            action: 'PUT',
            json: { custom: { a: 1 } }
          })
        }

        const document = await changeDocumentFor({
          alice,
          queryUrl,
          resourceId
        })
        const documentStamp = stampOf(document)
        if (metadataSupported) {
          const meta = await alice.rootClient.request({
            url: state.resourceMetaUrl(resourceId),
            method: 'GET'
          })
          assert.deepStrictEqual(documentStamp, stampOf(meta.data))
          stampOf(document.meta)
          assert.deepStrictEqual(document.meta, meta.data.meta)
        }

        await alice.rootClient.request({ url, method: 'DELETE' })
        const tombstone = await changeDocumentFor({
          alice,
          queryUrl,
          resourceId
        })
        assert.equal(tombstone.deleted, true)
        stampOf(tombstone)
      }
    },
    {
      id: 'write-stamp.create-echo-matches-read',
      name:
        '[root] a Space or Collection create echo carries the same stamp ' +
        'and ETag as the following read',
      specRefs: [
        'https://w3id.org/pws#create-space-operation',
        'https://w3id.org/pws#create-collection-add-collection-to-a-space-operation',
        'https://w3id.org/pws#space-metadata-data-model',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        const spaceId = ctx.generateId()
        const spaceUrl = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
        const spaceCreate = await ctx.createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Create Echo Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        try {
          const spaceRead = await alice.rootClient.request({
            url: spaceMetaUrl({ spaceUrl }),
            method: 'GET'
          })
          assert.deepStrictEqual(
            stampOf(spaceCreate.data),
            stampOf(spaceRead.data)
          )
          assert.equal(
            strongEtagOf(spaceCreate, 'the Space create'),
            spaceRead.headers.get('etag')
          )

          if (!metadataSupported) {
            ctx.skip(
              'the service description does not advertise metadata, so ' +
                'the Collection half was not checked'
            )
          }
          const collectionId = ctx.generateId()
          const collectionCreate = await alice.rootClient.request({
            url: spaceUrl,
            method: 'POST',
            action: 'POST',
            json: { id: collectionId, name: 'Create Echo Collection' }
          })
          const collectionRead = await alice.rootClient.request({
            url: collectionMetaUrl({ spaceUrl, collectionId }),
            method: 'GET'
          })
          assert.deepStrictEqual(
            stampOf(collectionCreate.data),
            stampOf(collectionRead.data)
          )
          assert.equal(
            strongEtagOf(collectionCreate, 'the Collection create'),
            collectionRead.headers.get('etag')
          )
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl,
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'write-stamp.etag-moves-every-write',
      name:
        '[root] the strong ETag moves on every write, including a write of ' +
        'an identical body',
      specRefs: [
        'https://w3id.org/pws#conditional-requests',
        'https://w3id.org/pws#caching'
      ],
      run: async (ctx, state) => {
        const { alice, spaceId, collectionId, metadataSupported } = state

        /**
         * Writes the same body twice and asserts each write moves the ETag
         * and the following read returns the latest one. When the target
         * already exists, the first write must also move the ETag a read
         * returned before it.
         */
        async function assertTwoWritesMoveEtag({
          url,
          readUrl,
          json,
          label,
          readBefore
        }: {
          url: string
          readUrl: string
          json: object
          label: string
          readBefore: boolean
        }): Promise<void> {
          const previous = readBefore
            ? strongEtagOf(
                await alice.rootClient.request({ url: readUrl, method: 'GET' }),
                `the ${label} read`
              )
            : undefined
          const write = async (): Promise<string> =>
            strongEtagOf(
              await alice.rootClient.request({
                url,
                method: 'PUT',
                action: 'PUT',
                json
              }),
              `the ${label} write`
            )
          const first = await write()
          assert.notEqual(
            first,
            previous,
            `expected the ${label} write to move the ETag`
          )
          const second = await write()
          assert.notEqual(
            second,
            first,
            `expected an identical ${label} write to move the ETag`
          )
          const read = await alice.rootClient.request({
            url: readUrl,
            method: 'GET'
          })
          assert.equal(read.headers.get('etag'), second)
        }

        const resourceId = ctx.generateId()
        const resourceUrl = state.resourceUrl(resourceId)
        await assertTwoWritesMoveEtag({
          url: resourceUrl,
          readUrl: resourceUrl,
          json: { id: resourceId, body: 'A' },
          label: 'Resource',
          readBefore: false
        })
        await assertTwoWritesMoveEtag({
          url: state.spaceMetaUrl,
          readUrl: state.spaceMetaUrl,
          json: {
            id: spaceId,
            name: 'ETag Write Stamp Space',
            controller: alice.did
          },
          label: 'Space Metadata',
          readBefore: true
        })
        if (!metadataSupported) {
          ctx.skip(
            'the service description does not advertise metadata, so the ' +
              'Collection and Resource metadata writes were not checked'
          )
        }
        await assertTwoWritesMoveEtag({
          url: state.collectionMetaUrl,
          readUrl: state.collectionMetaUrl,
          json: { id: collectionId, name: 'ETag Write Stamps' },
          label: 'Collection Metadata',
          readBefore: true
        })
        await assertTwoWritesMoveEtag({
          url: state.resourceMetaUrl(resourceId),
          readUrl: state.resourceMetaUrl(resourceId),
          json: { custom: { a: 1 } },
          label: 'Resource Metadata',
          readBefore: false
        })
      }
    },
    {
      id: 'write-stamp.origin-id-advertised',
      name:
        'the service description advertises the `originId` that stamps ' +
        "this server's writes",
      optional: true,
      specRefs: [
        'https://w3id.org/pws#service-description',
        'https://w3id.org/pws#space-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const document = await fetchServiceDescription(ctx.serverUrl)
        const entries: Array<{ originId?: unknown }> =
          document?.specs?.[PWS_SPEC_IDENTIFIER] ?? []
        const entry = entries.find(
          candidate => candidate?.originId !== undefined
        )
        if (!entry) {
          ctx.skip('the service description advertises no `originId`')
        }
        const { originId } = entry!
        assert.ok(
          typeof originId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(originId),
          'the advertised `originId` must match [A-Za-z0-9_-]{1,64}'
        )
        const meta = await state.alice.rootClient.request({
          url: state.spaceMetaUrl,
          method: 'GET'
        })
        assert.equal(stampOf(meta.data).originId, originId)
      }
    }
  ]
}
