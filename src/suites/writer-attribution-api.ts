/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- writer attribution (spec "Writer attribution:
 * `writerId` and `createdBy`").
 *
 * `writerId` is an opaque, client-declared attribution label on a Resource's
 * current revision. It rides the same Resource Metadata Data Model as
 * `custom` and `epoch`, so it is gated behind the same OPTIONAL `metadata`
 * feature token the server advertises in its service description. `setup()`
 * reads the document once; every test that depends on `/meta` or the Update
 * Resource Metadata operation skips when the token is absent, matching how
 * `changes-query-api` gates its own feature. The tombstone check further
 * depends on the `changes-query` feature, since the only place a delete's
 * `writerId` surfaces is that feed. The Collection listing check further
 * depends on the `listing` feature, and since a listing item's `writerId` is
 * optional, it only requires that a label the listing does carry is current.
 *
 * A content write (`PUT` or `POST`) and a `DELETE` declare the label via the
 * `Writer-Id` request header. They are declare-or-clear: an absent header
 * clears the stored label rather than preserving it. An Update Resource
 * Metadata request (`PUT .../meta`) leaves the label untouched, and a
 * `writerId` member in its body is not read.
 */
import {
  collectionQueryUrl,
  collectionUrl,
  resourceMetaUrl,
  resourceUrl as resourceUrlOf,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  spaceUrl: string
  collectionId: string
  metadataSupported: boolean
  changesSupported: boolean
  listingSupported: boolean
  resourceUrl: (id: string) => string
  resourceMetaUrl: (id: string) => string
  queryUrl: () => string
}

export const writerAttributionApi: Suite<State> = {
  id: 'writer-attribution-api',
  name: 'Writer attribution (writerId)',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const collectionId = 'attribution'
    alice.space1 = { id: ctx.generateId() }
    const spaceUrl = spaceUrlById({
      baseServerUrl: ctx.serverUrl,
      spaceId: alice.space1.id
    })

    /** Absolute URL for a Resource in this Space's `attribution` collection. */
    function resourceUrl(id: string): string {
      return resourceUrlOf({ spaceUrl, collectionId, resourceId: id })
    }

    function resourceMeta(id: string): string {
      return resourceMetaUrl({ spaceUrl, collectionId, resourceId: id })
    }

    /** Absolute URL for the `attribution` collection's changes-query endpoint. */
    function queryUrl(): string {
      return collectionQueryUrl({ spaceUrl, collectionId })
    }

    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Writer Attribution Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Writer Attribution' }
    })

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    const metadataSupported = features.includes('metadata')
    const changesSupported = features.includes('changes-query')
    const listingSupported = features.includes('listing')

    return {
      alice,
      spaceUrl,
      collectionId,
      metadataSupported,
      changesSupported,
      listingSupported,
      resourceUrl,
      resourceMetaUrl: resourceMeta,
      queryUrl
    }
  },

  teardown: async (ctx, state) => {
    const { alice, spaceUrl } = state
    try {
      await alice.rootClient.request({
        url: spaceUrl,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'writer-attribution.content-write-declares-and-clears',
      name:
        '[root] a content write declares `writerId` (/meta, and where ' +
        'served the listing and changes feed); a following write with no ' +
        'header clears it',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#resource-metadata-data-model',
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#list-collection-operation',
        'https://w3id.org/pws#query-profile-changes'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          spaceUrl,
          collectionId,
          metadataSupported,
          changesSupported,
          listingSupported
        } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)

        // A PUT declaring `Writer-Id: w1` stores it.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId },
          headers: { 'writer-id': 'w1' }
        })

        const meta1 = await alice.rootClient.request({
          url: state.resourceMetaUrl(resourceId),
          method: 'GET'
        })
        assert.equal(meta1.data.writerId, 'w1')

        // A listing item's `writerId` is optional. Where the item carries
        // one, it must be the current label.
        if (listingSupported) {
          const listing1 = await alice.rootClient.request({
            url: collectionUrl({ spaceUrl, collectionId }),
            method: 'GET'
          })
          const item1 = listing1.data.items.find(
            (it: any) => it.id === resourceId
          )
          assert.ok(item1, 'expected the written resource in the listing')
          if (item1.writerId !== undefined) {
            assert.equal(item1.writerId, 'w1')
          }
        }

        if (changesSupported) {
          const changes1 = await alice.rootClient.request({
            url: state.queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', limit: 1000 }
          })
          const doc1 = changes1.data.documents.find(
            (doc: any) => doc.kind === 'resource' && doc.id === resourceId
          )
          assert.ok(doc1, 'expected the written resource in the changes feed')
          assert.equal(doc1.writerId, 'w1')
        }

        // A following PUT with no `Writer-Id` header clears the stored label.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId, updated: true }
        })

        const meta2 = await alice.rootClient.request({
          url: state.resourceMetaUrl(resourceId),
          method: 'GET'
        })
        assert.equal(meta2.data.writerId, undefined)

        // A cleared label must not linger on the listing item.
        if (listingSupported) {
          const listing2 = await alice.rootClient.request({
            url: collectionUrl({ spaceUrl, collectionId }),
            method: 'GET'
          })
          const item2 = listing2.data.items.find(
            (it: any) => it.id === resourceId
          )
          assert.ok(item2, 'expected the updated resource in the listing')
          assert.equal(item2.writerId, undefined)
        }

        if (changesSupported) {
          const changes2 = await alice.rootClient.request({
            url: state.queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', limit: 1000 }
          })
          const doc2 = changes2.data.documents.find(
            (doc: any) => doc.kind === 'resource' && doc.id === resourceId
          )
          assert.ok(doc2, 'expected the cleared resource in the changes feed')
          assert.equal(doc2.writerId, undefined)
        }
      }
    },
    {
      id: 'writer-attribution.create-post-declares',
      name: '[root] POST (create) with `Writer-Id` stores it too',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice, spaceUrl, collectionId, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const created = await alice.rootClient.request({
          url: collectionUrl({ spaceUrl, collectionId }),
          method: 'POST',
          action: 'POST',
          json: { message: 'hi' },
          headers: { 'writer-id': 'w3' }
        })
        const resourceUrl = created.headers.get('location')
        assert.ok(resourceUrl, 'expected a Location header on the create')

        const meta = await alice.rootClient.request({
          // Resolved from the server's `Location`, so the id is not known.
          url: `${resourceUrl}/meta`,
          method: 'GET'
        })
        assert.equal(meta.data.writerId, 'w3')
      }
    },
    {
      id: 'writer-attribution.delete-tombstone-writer-id',
      name: '[root] DELETE with `Writer-Id` attributes the tombstone',
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
        'https://w3id.org/pws#delete-resource-operation',
        'https://w3id.org/pws#query-profile-changes'
      ],
      run: async (ctx, state) => {
        const { alice, changesSupported } = state
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
        await alice.rootClient.request({
          url,
          method: 'DELETE',
          headers: { 'writer-id': 'w2' }
        })

        const changes = await alice.rootClient.request({
          url: state.queryUrl(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 1000 }
        })
        const tombstone = changes.data.documents.find(
          (doc: any) => doc.kind === 'resource' && doc.id === resourceId
        )
        assert.ok(
          tombstone,
          'expected the deleted resource in the changes feed'
        )
        assert.equal(tombstone.deleted, true)
        assert.equal(tombstone.writerId, 'w2')
      }
    },
    {
      id: 'writer-attribution.meta-put-member-ignored',
      name:
        '[root] a top-level `writerId` member on Update Resource Metadata ' +
        "is ignored: accepted, and the content write's label is left untouched",
      specRefs: [
        'https://w3id.org/pws#writer-attribution',
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
          json: { id: resourceId },
          headers: { 'writer-id': 'w5' }
        })

        // The server does not read a `writerId` member: any value, even one
        // a header would reject, is accepted and leaves the label as is.
        for (const json of [
          { custom: {}, writerId: 'other' },
          { writerId: '' },
          { writerId: 123 }
        ]) {
          const response = await alice.rootClient.request({
            url: state.resourceMetaUrl(resourceId),
            method: 'PUT',
            action: 'PUT',
            json
          })
          assert.ok(
            response.status === 204 || response.status === 200,
            `expected 204 or 200 for ${JSON.stringify(json)}, got ${response.status}`
          )
          const meta = await alice.rootClient.request({
            url: state.resourceMetaUrl(resourceId),
            method: 'GET'
          })
          assert.equal(meta.data.writerId, 'w5')
        }
      }
    },
    {
      id: 'writer-attribution.invalid-header-empty-400',
      name: '[root] an empty `Writer-Id` header is invalid-request-body (400)',
      specRefs: ['https://w3id.org/pws#writer-attribution'],
      run: async (ctx, state) => {
        const { alice, metadataSupported } = state
        if (!metadataSupported) {
          ctx.skip('the service description does not advertise metadata')
        }
        const resourceId = ctx.generateId()
        const url = state.resourceUrl(resourceId)
        let expectedError: any
        try {
          await alice.rootClient.request({
            url,
            method: 'PUT',
            action: 'PUT',
            json: { id: resourceId },
            headers: { 'writer-id': '' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the empty header to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    }
  ]
}
