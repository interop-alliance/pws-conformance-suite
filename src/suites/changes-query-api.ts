/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collection `changes` query profile (the replication
 * change feed served at `POST /space/:s/:c/query`; spec "Collection-level
 * reserved endpoints").
 *
 * The profile is OPTIONAL and advertised server-wide: a server that serves it
 * carries the `changes-query` token in the `features` array of its service
 * description's WAS version entry. It varies by whether the server keeps an
 * ordered change log at all rather than by backend, which is why the token sits
 * there and not on a Backend description. `setup()` reads the document and the
 * tests exercising the profile skip when the token is absent. The two that
 * exercise the query endpoint's profile dispatch (an unknown profile, an
 * omitted one) hold for any server serving the OPTIONAL query endpoint. They
 * run when the server advertises `query`, or `changes-query`, which implies
 * the endpoint, and skip otherwise.
 *
 * The feed carries every record of a Collection, one document per record,
 * discriminated on `kind`: `resource` (a Resource or its tombstone, whatever
 * its content type), `collection-metadata` (the Collection Metadata object),
 * `policy`, and `log` (the governing history log). A consumer skips a kind it
 * does not know, so the cases that count Resources filter on
 * `kind === 'resource'`. A fresh Collection's feed is not empty: its create
 * takes a position for the `collection-metadata` document.
 *
 * The checkpoint is an opaque string the server issues, scoped to the server
 * and Collection. These tests compare it by equality only and never read inside
 * it. Tests that write to the feed do so in a Collection of their own, so the
 * shared `feed` Collection keeps exactly the three Resource documents `setup()`
 * wrote.
 */
import {
  collectionLogUrl,
  collectionMetaUrl,
  collectionQueryUrl,
  resourceUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import {
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  serviceFeatures
} from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'
import { assertWriteStamp } from '../helpers.js'

interface State {
  alice: any
  spaceUrl: string
  collectionId: string
  changesSupported: boolean
  querySupported: boolean
  governedSupported: boolean
  queryUrl: () => string
  /**
   * Absolute URL of a Collection's Metadata object, or of its governing
   * history log (`log`).
   */
  metaUrl: (collectionId: string, subPath?: 'log') => string
  /**
   * Creates a fresh Collection in Alice's Space and returns its id.
   */
  createCollection: () => Promise<string>
  /**
   * Writes the JSON `body` to a Resource by id.
   */
  putResource: (options: {
    collectionId: string
    resourceId: string
    body: unknown
  }) => Promise<void>
  /**
   * Writes raw bytes to a Resource by id under the given media type.
   */
  putBytes: (options: {
    collectionId: string
    resourceId: string
    bytes: Uint8Array
    contentType: string
    headers?: Record<string, string>
  }) => Promise<any>
  /**
   * Posts one `changes` query to a Collection and returns the response body.
   */
  pullPage: (options: {
    collectionId: string
    checkpoint?: unknown
    limit?: number
  }) => Promise<{ documents: any[]; checkpoint: string | null }>
}

/**
 * The `kind` values the profile defines. A server emits no other.
 */
const DOCUMENT_KINDS = ['resource', 'collection-metadata', 'policy', 'log']

/**
 * A one-epoch `edv` key-epoch descriptor, the head state of a governing log's
 * genesis line.
 */
const oneEpoch = {
  type: 'WasEpochConfiguration',
  scheme: 'edv',
  currentEpoch: 'urn:epoch:1',
  epochs: [
    {
      id: 'urn:epoch:1',
      recipients: [
        {
          header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
          encrypted_key: 'wrapped-1'
        }
      ]
    }
  ]
}

/**
 * The same descriptor after one rotation, the head state of an appended line.
 */
const twoEpochs = {
  ...oneEpoch,
  currentEpoch: 'urn:epoch:2',
  epochs: [
    {
      id: 'urn:epoch:2',
      recipients: [
        {
          header: { kid: 'did:key:zApp2#ka', alg: 'ECDH-ES+A256KW' },
          encrypted_key: 'wrapped-2'
        }
      ]
    },
    ...oneEpoch.epochs
  ]
}

/**
 * One governing-log line. The server reads only `state` and the genesis
 * line's `parameters.method`.
 *
 * @param options {object}
 * @param options.ordinal {number}
 * @param options.state {object}
 * @returns {string}   the line, newline-terminated
 */
function logLine({
  ordinal,
  state
}: {
  ordinal: number
  state: object
}): string {
  const parameters =
    ordinal === 1 ? { method: 'resource-log:0.1', scid: 'zScid' } : {}
  return (
    JSON.stringify({
      versionId: `${ordinal}-hash${ordinal}`,
      versionTime: '2026-10-04T00:00:00Z',
      parameters,
      state,
      proof: []
    }) + '\n'
  )
}

const PROBLEM_INVALID_REQUEST_BODY = 'https://w3id.org/pws#invalid-request-body'

/**
 * Asserts that a feed page carries an opaque string checkpoint on each
 * document, and that the page's checkpoint equals the last document's (or is
 * `null` on an empty page).
 *
 * @param page {object}
 * @param page.documents {any[]}
 * @param page.checkpoint {string | null}
 */
function assertPageCheckpoints(page: {
  documents: any[]
  checkpoint: string | null
}): void {
  for (const doc of page.documents) {
    assert.equal(
      typeof doc.checkpoint,
      'string',
      `document "${doc.id}" carries no string checkpoint`
    )
  }
  if (page.documents.length === 0) {
    assert.equal(page.checkpoint, null)
    return
  }
  assert.equal(typeof page.checkpoint, 'string')
  assert.equal(
    page.checkpoint,
    page.documents[page.documents.length - 1].checkpoint
  )
}

/**
 * Asserts the members every feed document carries whatever its `kind`: the
 * `kind` itself, a boolean `deleted` (and no retired `_deleted`), the record's
 * write stamp, its `generation`, its quoted `etag`, and its `checkpoint`.
 *
 * @param doc {any}   one feed document
 */
function assertCommonMembers(doc: any): void {
  assert.ok(
    DOCUMENT_KINDS.includes(doc.kind),
    `document "${doc.id}" carries no known \`kind\` (got ${doc.kind})`
  )
  assert.equal(typeof doc.id, 'string')
  assert.equal(
    typeof doc.deleted,
    'boolean',
    `document "${doc.id}" carries no boolean \`deleted\``
  )
  assert.equal(
    '_deleted' in doc,
    false,
    `document "${doc.id}" carries the retired \`_deleted\` member`
  )
  assertWriteStamp(doc)
  assert.equal(
    typeof doc.generation,
    'string',
    `document "${doc.id}" carries no string \`generation\``
  )
  assert.match(
    doc.etag ?? '',
    /^"[^"]+"$/,
    `document "${doc.id}" carries no quoted strong \`etag\``
  )
  assert.equal(typeof doc.checkpoint, 'string')
}

/**
 * The documents of a page whose `kind` is `resource`.
 *
 * @param page {object}
 * @param page.documents {any[]}
 * @returns {any[]}
 */
function resourceDocuments(page: { documents: any[] }): any[] {
  return page.documents.filter((doc: any) => doc.kind === 'resource')
}

export const changesQueryApi: Suite<State> = {
  id: 'changes-query-api',
  name: 'Collection changes query profile',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const collectionId = 'feed'
    alice.space1 = { id: ctx.generateId() }
    const spaceUrl = spaceUrlById({
      baseServerUrl: ctx.serverUrl,
      spaceId: alice.space1.id
    })

    /** Absolute URL for this Space's `feed` collection query endpoint. */
    function queryUrl(): string {
      return collectionQueryUrl({ spaceUrl, collectionId })
    }

    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Feed' }
    })
    // Three JSON documents by id; the middle one is then soft-deleted.
    for (const id of ['r1', 'r2', 'r3']) {
      await alice.rootClient.request({
        url: resourceUrl({ spaceUrl, collectionId, resourceId: id }),
        method: 'PUT',
        action: 'PUT',
        json: { id }
      })
    }
    await alice.rootClient.request({
      url: resourceUrl({ spaceUrl, collectionId, resourceId: 'r2' }),
      method: 'DELETE'
    })

    const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
    const changesSupported = features.includes('changes-query')
    // A server serving the `changes` profile serves the query endpoint too.
    const querySupported = features.includes('query') || changesSupported
    const encryptedFeatures = await serviceFeatures({
      serverUrl: ctx.serverUrl,
      specIdentifier: ENCRYPTED_COLLECTIONS_IDENTIFIER
    })
    const governedSupported = encryptedFeatures.includes(
      'governed-history-logs'
    )

    /**
     * Absolute URL of a Collection's Metadata object, or of its governing
     * history log.
     *
     * @param targetCollectionId {string}
     * @param [subPath] {'log'}
     * @returns {string}
     */
    function metaUrl(targetCollectionId: string, subPath?: 'log'): string {
      const target = { spaceUrl, collectionId: targetCollectionId }
      return subPath === 'log'
        ? collectionLogUrl(target)
        : collectionMetaUrl(target)
    }

    /**
     * Creates a fresh Collection in Alice's Space.
     *
     * @returns {Promise<string>} the new Collection's id
     */
    async function createCollection(): Promise<string> {
      const id = ctx.generateId()
      await alice.rootClient.request({
        url: spaceUrl,
        method: 'POST',
        action: 'POST',
        json: { id, name: 'Feed ordering' }
      })
      return id
    }

    /**
     * Writes a JSON body to a Resource by id.
     *
     * @param options {object}
     * @param options.collectionId {string}
     * @param options.resourceId {string}
     * @param options.body {unknown}
     */
    async function putResource({
      collectionId: targetCollectionId,
      resourceId,
      body
    }: {
      collectionId: string
      resourceId: string
      body: unknown
    }): Promise<void> {
      await alice.rootClient.request({
        url: resourceUrl({
          spaceUrl,
          collectionId: targetCollectionId,
          resourceId
        }),
        method: 'PUT',
        action: 'PUT',
        json: body
      })
    }

    /**
     * Writes raw bytes to a Resource by id.
     *
     * @param options {object}
     * @param options.collectionId {string}
     * @param options.resourceId {string}
     * @param options.bytes {Uint8Array}
     * @param options.contentType {string}
     * @param [options.headers] {object}   extra request headers
     * @returns {Promise<any>} the response
     */
    async function putBytes({
      collectionId: targetCollectionId,
      resourceId,
      bytes,
      contentType,
      headers = {}
    }: {
      collectionId: string
      resourceId: string
      bytes: Uint8Array
      contentType: string
      headers?: Record<string, string>
    }): Promise<any> {
      return alice.rootClient.request({
        url: resourceUrl({
          spaceUrl,
          collectionId: targetCollectionId,
          resourceId
        }),
        method: 'PUT',
        action: 'PUT',
        headers: { 'content-type': contentType, ...headers },
        body: bytes
      })
    }

    /**
     * Posts one `changes` query to a Collection.
     *
     * @param options {object}
     * @param options.collectionId {string}
     * @param [options.checkpoint] {unknown}   sent verbatim when present
     * @param [options.limit] {number}
     * @returns {Promise<object>} the response body
     */
    async function pullPage({
      collectionId: targetCollectionId,
      checkpoint,
      limit = 100
    }: {
      collectionId: string
      checkpoint?: unknown
      limit?: number
    }): Promise<{ documents: any[]; checkpoint: string | null }> {
      const response = await alice.rootClient.request({
        url: collectionQueryUrl({ spaceUrl, collectionId: targetCollectionId }),
        method: 'POST',
        action: 'POST',
        json: {
          profile: 'changes',
          ...(checkpoint !== undefined && { checkpoint }),
          limit
        }
      })
      assert.equal(response.status, 200)
      return response.data
    }

    return {
      alice,
      spaceUrl,
      collectionId,
      changesSupported,
      querySupported,
      governedSupported,
      queryUrl,
      metaUrl,
      createCollection,
      putResource,
      putBytes,
      pullPage
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
      id: 'changes.live-docs-tombstone-checkpoint',
      name: '[root] returns live documents and a tombstone, with a checkpoint',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const response = await alice.rootClient.request({
          url: queryUrl(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100 }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)

        const byId = new Map(
          resourceDocuments(response.data).map((doc: any) => [doc.id, doc])
        )
        assert.deepEqual([...byId.keys()].sort(), ['r1', 'r2', 'r3'])

        // Live documents carry their body under `data`, `deleted: false`,
        // and their stored `contentType`.
        const live = byId.get('r1') as any
        assert.equal(live.deleted, false)
        assert.deepEqual(live.data, { id: 'r1' })
        assert.match(live.contentType ?? '', /^application\/json/)

        // The deleted document is a tombstone: `deleted: true`, no `data`,
        // and the last-known `contentType`.
        const tombstone = byId.get('r2') as any
        assert.equal(tombstone.deleted, true)
        assert.equal(tombstone.data, undefined)
        assert.match(tombstone.contentType ?? '', /^application\/json/)

        // The checkpoint is an opaque string equal to the last returned
        // document's own checkpoint, and every document carries one.
        assert.ok(response.data.checkpoint)
        assertPageCheckpoints(response.data)
      }
    },
    {
      id: 'changes.unknown-profile-501',
      name: '[root] rejects an unknown query profile with 501',
      specRefs: ['https://w3id.org/pws#query-profile-registry'],
      run: async (ctx, state) => {
        const { alice, queryUrl, querySupported } = state
        if (!querySupported) {
          ctx.skip('the service description does not advertise query')
        }
        let thrown: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'no-such-profile' }
          })
        } catch (err) {
          thrown = err
        }
        assert.ok(thrown, 'expected an unknown profile to be rejected')
        assert.equal(thrown.response.status, 501)
        // `application/problem+json` is a SHOULD, so the media type is not
        // asserted. The `type` member is REQUIRED.
        assert.equal(
          thrown.data?.type,
          'https://w3id.org/pws#unsupported-operation'
        )
      }
    },
    {
      id: 'changes.missing-profile-400',
      name: '[root] rejects a query body with no `profile` with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-registry',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl, querySupported } = state
        if (!querySupported) {
          ctx.skip('the service description does not advertise query')
        }
        // The Query Profile Registry marks `profile` REQUIRED: a body that
        // omits it is malformed (`invalid-request-body`, 400), distinct from
        // naming a profile the server does not serve (501).
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { limit: 10 }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the missing profile to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'changes.malformed-checkpoint-400',
      name:
        '[root] a `changes` query with a malformed `checkpoint` is rejected ' +
        'with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // A checkpoint the server did not issue is rejected with
        // `invalid-request-body` (400).
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'changes',
              checkpoint: 'not-issued-by-this-server'
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the malformed checkpoint to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'changes.concurrent-writes-not-skipped',
      name:
        '[root] two concurrent writes to one Collection both surface when ' +
        'the feed is paged between them',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, createCollection, putResource, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // Two writes fired together are likely to share an `updatedAt`. The
        // feed is ordered by the server's feed position, so neither may be
        // skipped by a checkpoint taken between them. The Collection's create
        // took a position of its own, so the pages start past it.
        const targetCollectionId = await createCollection()
        const created = await pullPage({ collectionId: targetCollectionId })
        assert.equal(typeof created.checkpoint, 'string')
        const start = created.checkpoint as string
        await Promise.all(
          ['a', 'b'].map(resourceId =>
            putResource({
              collectionId: targetCollectionId,
              resourceId,
              body: { resourceId }
            })
          )
        )

        const first = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: start,
          limit: 1
        })
        assert.equal(first.documents.length, 1)
        assertPageCheckpoints(first)
        const second = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: first.checkpoint,
          limit: 1
        })
        assert.equal(second.documents.length, 1)
        assertPageCheckpoints(second)
        assert.notEqual(second.checkpoint, first.checkpoint)
        assert.deepEqual(
          [first.documents[0].id, second.documents[0].id].sort(),
          ['a', 'b']
        )
        const end = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: second.checkpoint,
          limit: 1
        })
        assert.deepEqual(end.documents, [])
        assert.equal(end.checkpoint, null)

        // A document's own checkpoint resumes right after that document.
        const whole = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: start
        })
        assert.equal(whole.documents.length, 2)
        assertPageCheckpoints(whole)
        const rest = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: whole.documents[0].checkpoint
        })
        assert.deepEqual(
          rest.documents.map((doc: any) => doc.id),
          [whole.documents[1].id]
        )
      }
    },
    {
      id: 'changes.rewrite-after-checkpoint-surfaces',
      name:
        '[root] a write made after a checkpoint was issued surfaces when ' +
        'that checkpoint is echoed back',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, createCollection, putResource, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const targetCollectionId = await createCollection()
        await putResource({
          collectionId: targetCollectionId,
          resourceId: 'x',
          body: { revision: 1 }
        })

        // Drain the feed to its end, keeping the last checkpoint issued.
        let checkpoint: string | undefined
        for (let page = 0; page < 50; page++) {
          const result = await pullPage({
            collectionId: targetCollectionId,
            ...(checkpoint !== undefined && { checkpoint })
          })
          if (result.checkpoint === null) {
            break
          }
          checkpoint = result.checkpoint
        }
        assert.ok(checkpoint, 'expected the feed to issue a checkpoint')

        // Rewrite `x` right away, then resume from the checkpoint.
        await putResource({
          collectionId: targetCollectionId,
          resourceId: 'x',
          body: { revision: 2 }
        })
        const resumed = await pullPage({
          collectionId: targetCollectionId,
          checkpoint
        })
        assertPageCheckpoints(resumed)
        const rewritten = resumed.documents.find((doc: any) => doc.id === 'x')
        assert.ok(
          rewritten,
          'expected the rewrite to surface past the checkpoint'
        )
        assert.deepEqual(rewritten.data, { revision: 2 })
      }
    },
    {
      id: 'changes.retired-object-checkpoint-400',
      name:
        '[root] a `changes` query with an `{ id, updatedAt }` object ' +
        'checkpoint is rejected with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, queryUrl, changesSupported } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // The checkpoint is an opaque string; the retired object shape is a
        // checkpoint the server did not issue.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'changes',
              checkpoint: { id: 'r1', updatedAt: '2026-01-01T00:00:00.000Z' }
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the object checkpoint to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(expectedError.data.type, PROBLEM_INVALID_REQUEST_BODY)
      }
    },
    {
      id: 'changes.foreign-collection-checkpoint-400',
      name:
        '[root] a checkpoint issued for another Collection is rejected ' +
        'with 400',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          queryUrl,
          changesSupported,
          createCollection,
          putResource,
          pullPage
        } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // A checkpoint is scoped to the Collection that issued it.
        const otherCollectionId = await createCollection()
        await putResource({
          collectionId: otherCollectionId,
          resourceId: 'elsewhere',
          body: { elsewhere: true }
        })
        const other = await pullPage({ collectionId: otherCollectionId })
        assert.equal(typeof other.checkpoint, 'string')

        let expectedError: any
        try {
          await alice.rootClient.request({
            url: queryUrl(),
            method: 'POST',
            action: 'POST',
            json: { profile: 'changes', checkpoint: other.checkpoint }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          "expected another Collection's checkpoint to be rejected"
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(expectedError.data.type, PROBLEM_INVALID_REQUEST_BODY)
      }
    },
    {
      id: 'changes.kind-on-every-document',
      name: '[root] every feed document carries a `kind` from the defined set',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, collectionId, pullPage } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const page = await pullPage({ collectionId })
        assert.ok(page.documents.length > 0, 'expected a non-empty feed')
        for (const doc of page.documents) {
          assert.ok(
            DOCUMENT_KINDS.includes(doc.kind),
            `document "${doc.id}" carries no known \`kind\` (got ${doc.kind})`
          )
        }
        // The shared Collection's create and its three writes surface as one
        // `collection-metadata` document and three `resource` documents.
        assert.deepEqual(
          page.documents
            .filter((doc: any) => doc.kind === 'collection-metadata')
            .map((doc: any) => doc.id),
          [state.metaUrl(collectionId)]
        )
        assert.equal(resourceDocuments(page).length, 3)
      }
    },
    {
      id: 'changes.deleted-member',
      name:
        '[root] every feed document carries a boolean `deleted` and no ' +
        '`_deleted`',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { changesSupported, collectionId, pullPage } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const page = await pullPage({ collectionId })
        for (const doc of page.documents) {
          assert.equal(
            typeof doc.deleted,
            'boolean',
            `document "${doc.id}" carries no boolean \`deleted\``
          )
          assert.equal(
            '_deleted' in doc,
            false,
            `document "${doc.id}" carries the retired \`_deleted\` member`
          )
        }
        const deleted = page.documents
          .filter((doc: any) => doc.deleted)
          .map((doc: any) => doc.id)
        assert.deepEqual(deleted, ['r2'])
      }
    },
    {
      id: 'changes.document-stamp-generation-etag',
      name:
        '[root] every feed document carries its write stamp, `generation`, ' +
        'and quoted `etag`',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { alice, spaceUrl, changesSupported, collectionId, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const page = await pullPage({ collectionId })
        for (const doc of page.documents) {
          assertCommonMembers(doc)
        }
        // A live Resource's `etag` is the one its GET serves.
        const live = resourceDocuments(page).find((doc: any) => doc.id === 'r1')
        const read = await alice.rootClient.request({
          url: resourceUrl({ spaceUrl, collectionId, resourceId: 'r1' }),
          method: 'GET'
        })
        assert.equal(live.etag, read.headers.get('etag'))
      }
    },
    {
      id: 'changes.non-json-resource-and-tombstone',
      name:
        '[root] a binary and a `text/jsonl` Resource and their tombstones ' +
        'appear with `contentType` and no `data`',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const {
          alice,
          spaceUrl,
          changesSupported,
          createCollection,
          putBytes,
          pullPage
        } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const targetCollectionId = await createCollection()
        const written = [
          {
            resourceId: 'blob',
            contentType: 'application/octet-stream',
            bytes: new Uint8Array([0, 1, 2, 255])
          },
          {
            resourceId: 'lines',
            contentType: 'text/jsonl',
            bytes: new TextEncoder().encode('{"a":1}\n{"a":2}\n')
          }
        ]
        for (const resource of written) {
          await putBytes({ collectionId: targetCollectionId, ...resource })
        }

        const live = resourceDocuments(
          await pullPage({ collectionId: targetCollectionId })
        )
        assert.deepEqual(live.map((doc: any) => doc.id).sort(), [
          'blob',
          'lines'
        ])
        for (const { resourceId, contentType } of written) {
          const doc = live.find((entry: any) => entry.id === resourceId)
          assert.equal(doc.deleted, false)
          assert.ok(
            doc.contentType.startsWith(contentType),
            `expected ${resourceId} to carry contentType ${contentType}, ` +
              `got ${doc.contentType}`
          )
          assert.equal(
            'data' in doc,
            false,
            `a non-JSON Resource (${resourceId}) carries no inline \`data\``
          )
        }

        for (const { resourceId } of written) {
          await alice.rootClient.request({
            url: resourceUrl({
              spaceUrl,
              collectionId: targetCollectionId,
              resourceId
            }),
            method: 'DELETE'
          })
        }
        const tombstones = resourceDocuments(
          await pullPage({ collectionId: targetCollectionId })
        )
        for (const { resourceId, contentType } of written) {
          const doc = tombstones.find((entry: any) => entry.id === resourceId)
          assert.ok(doc, `expected the ${resourceId} tombstone in the feed`)
          assert.equal(doc.deleted, true)
          assert.ok(
            doc.contentType.startsWith(contentType),
            `expected the ${resourceId} tombstone to carry its last-known ` +
              `contentType ${contentType}, got ${doc.contentType}`
          )
          assert.equal('data' in doc, false)
        }
      }
    },
    {
      id: 'changes.collection-metadata-document',
      name:
        '[root] the Collection Metadata object appears as a ' +
        '`collection-metadata` document that moves on each Metadata write',
      specRefs: [
        'https://w3id.org/pws#query-profile-changes',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { alice, changesSupported, createCollection, metaUrl, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        const targetCollectionId = await createCollection()
        const url = metaUrl(targetCollectionId)

        // The create takes a position: a fresh Collection's feed holds the
        // Metadata object's document, with the `ETag` its GET serves.
        const created = await pullPage({ collectionId: targetCollectionId })
        assertPageCheckpoints(created)
        assert.equal(created.documents.length, 1)
        const [first] = created.documents
        assert.equal(first.kind, 'collection-metadata')
        assert.equal(first.id, url)
        assert.equal(first.deleted, false)
        assert.equal(typeof first.generation, 'string')
        assert.equal('data' in first, false)
        const firstRead = await alice.rootClient.request({ url, method: 'GET' })
        assert.equal(first.etag, firstRead.headers.get('etag'))

        // A Metadata write moves it to a new position with the new `ETag`.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          json: { id: targetCollectionId, name: 'Renamed' }
        })
        const secondRead = await alice.rootClient.request({
          url,
          method: 'GET'
        })
        const moved = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: created.checkpoint
        })
        assert.equal(moved.documents.length, 1)
        const [second] = moved.documents
        assert.equal(second.kind, 'collection-metadata')
        assert.equal(second.id, url)
        assert.equal(second.etag, secondRead.headers.get('etag'))
        assert.notEqual(second.etag, first.etag)

        // The record appears once, at the position of its latest write.
        const whole = await pullPage({ collectionId: targetCollectionId })
        assert.deepEqual(
          whole.documents.map((doc: any) => doc.etag),
          [second.etag]
        )
      }
    },
    {
      id: 'changes.mixed-kind-paging',
      name:
        '[root] a feed of mixed kinds pages one document at a time by ' +
        'per-document checkpoint, in write order',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const {
          alice,
          changesSupported,
          createCollection,
          metaUrl,
          putResource,
          putBytes,
          pullPage
        } = state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        // The Metadata write comes last, so its document follows both
        // Resource documents.
        const targetCollectionId = await createCollection()
        await putResource({
          collectionId: targetCollectionId,
          resourceId: 'a',
          body: { a: true }
        })
        await putBytes({
          collectionId: targetCollectionId,
          resourceId: 'b',
          bytes: new Uint8Array([7]),
          contentType: 'application/octet-stream'
        })
        await alice.rootClient.request({
          url: metaUrl(targetCollectionId),
          method: 'PUT',
          action: 'PUT',
          json: { id: targetCollectionId, name: 'Mixed' }
        })

        const whole = await pullPage({ collectionId: targetCollectionId })
        assertPageCheckpoints(whole)
        const keys = whole.documents.map((doc: any) => `${doc.kind} ${doc.id}`)
        assert.deepEqual(keys, [
          'resource a',
          'resource b',
          `collection-metadata ${metaUrl(targetCollectionId)}`
        ])

        const paged: string[] = []
        let checkpoint: string | undefined
        for (let page = 0; page < 10; page++) {
          const result = await pullPage({
            collectionId: targetCollectionId,
            ...(checkpoint !== undefined && { checkpoint }),
            limit: 1
          })
          assertPageCheckpoints(result)
          if (result.checkpoint === null) {
            assert.deepEqual(result.documents, [])
            break
          }
          assert.equal(result.documents.length, 1)
          const [doc] = result.documents
          assertCommonMembers(doc)
          paged.push(`${doc.kind} ${doc.id}`)
          checkpoint = result.checkpoint
        }
        assert.deepEqual(paged, keys)
      }
    },
    {
      id: 'changes.log-document',
      name:
        '[root] a governing history log appears as a `log` document that ' +
        'moves on each append',
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { alice, changesSupported, createCollection, metaUrl, pullPage } =
          state
        if (!changesSupported) {
          ctx.skip('the service description does not advertise changes-query')
        }
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const targetCollectionId = await createCollection()
        const url = metaUrl(targetCollectionId, 'log')

        /**
         * Writes the log body under the given precondition headers.
         *
         * @param options {object}
         * @param options.body {string}
         * @param options.headers {object}
         * @returns {Promise<string>} the response's `ETag`
         */
        async function writeLog({
          body,
          headers
        }: {
          body: string
          headers: Record<string, string>
        }): Promise<string> {
          const response = await alice.rootClient.request({
            url,
            method: 'PUT',
            action: 'PUT',
            headers: { 'content-type': 'text/jsonl', ...headers },
            body: new TextEncoder().encode(body)
          })
          const etag = response.headers.get('etag')
          assert.ok(etag, 'expected the log write to return an ETag')
          return etag
        }

        // The guarded create takes a position.
        const before = await pullPage({ collectionId: targetCollectionId })
        const genesis = logLine({ ordinal: 1, state: oneEpoch })
        const createdEtag = await writeLog({
          body: genesis,
          headers: { 'if-none-match': '*' }
        })
        const created = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: before.checkpoint
        })
        assertPageCheckpoints(created)
        const first = created.documents.find((doc: any) => doc.kind === 'log')
        assert.ok(first, 'expected a `log` document after the guarded create')
        assert.equal(first.id, url)
        assert.equal(first.deleted, false)
        assert.equal(first.etag, createdEtag)
        assert.equal('data' in first, false)
        assertCommonMembers(first)

        // An append takes a new one, with the append's `ETag`.
        const appendedEtag = await writeLog({
          body: genesis + logLine({ ordinal: 2, state: twoEpochs }),
          headers: { 'if-match': createdEtag }
        })
        const appended = await pullPage({
          collectionId: targetCollectionId,
          checkpoint: created.checkpoint
        })
        const logDocs = appended.documents.filter(
          (doc: any) => doc.kind === 'log'
        )
        assert.equal(logDocs.length, 1)
        assert.equal(logDocs[0].id, url)
        assert.equal(logDocs[0].etag, appendedEtag)
        assert.notEqual(appendedEtag, createdEtag)
      }
    }
  ]
}
