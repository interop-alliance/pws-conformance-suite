/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Chunked Resources.
 *
 * The chunk endpoints belong to the Encrypted Collections profile, not to WAS
 * core. That spec's "Chunked resources" section owns the paths, the canonical
 * index rule, the error types, the lifecycle, and the authorization scoping;
 * WAS core keeps only the `chunks` row of its Reserved Path Segment Registry,
 * naming that document as the owner. Serving the endpoints is required of a
 * server that implements the profile, and no feature token advertises them.
 *
 * No feature token advertises the endpoints: listing the Encrypted Collections
 * profile under `specs` in the service description is itself the claim that
 * they are served. So setup() reads that document and each test skips when the
 * server lists no entry under the profile's identifier; where it does, the
 * behaviors below run at their MUST-level tier.
 *
 * A chunk is addressed at
 * `/space/{space}/{collection}/{resource}/chunks/{index}` in member form and
 * `.../chunks/` in container form. A chunk body is opaque bytes plus a content
 * type -- the server stores it exactly like a binary Resource representation and
 * never parses it (framing and any client-side encryption are the client's
 * concern). The parent Resource MUST already exist before any chunk is written.
 */
import { spaceUrlById } from '@interop/was-client/paths'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import assert from '../harness/assert.js'
import {
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  servesSpec
} from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  chunkedSupported: boolean
  /** Absolute URL of a chunk member (no trailing slash). */
  chunkUrl: (options: {
    collectionId: string
    resourceId: string
    index: number | string
  }) => string
  /** Absolute URL of a chunk container (trailing slash). */
  chunksListUrl: (options: {
    collectionId: string
    resourceId: string
  }) => string
  /** Absolute URL of a Resource member. */
  resourceUrl: (options: { collectionId: string; resourceId: string }) => string
  /** Creates a parent Resource under the plaintext `data` Collection. */
  createParent: (resourceId: string) => Promise<void>
}

/**
 * A minimal conforming EDV Encrypted Document, the stored representation an
 * `edv` (encrypted) Collection requires for a Resource's own content. Reused as
 * the parent-Resource body when exercising the "chunk bodies are never parsed,
 * even under an encryption descriptor" rule.
 */
const edvDocument = {
  id: 'stream-parent',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

/**
 * Signs and sends a raw chunk write against an arbitrary URL with an arbitrary
 * capability -- the mismatched-target invocation a well-behaved client refuses
 * to build (ezcap's confused-deputy guard), so the bytes are signed with the
 * low-level `signCapabilityInvocation` primitive and sent via raw `fetch`.
 *
 * @param options {object}
 * @param options.url {string}   the request URL to invoke against
 * @param options.capability {IZcap}   the delegated capability to embed
 * @param options.body {Uint8Array}   the raw chunk bytes
 * @param options.invocationSigner {ISigner}   the invoker's signer
 * @returns {Promise<Response>}
 */
async function writeChunkAt({
  url,
  capability,
  body,
  invocationSigner
}: {
  url: string
  capability: IZcap
  body: Uint8Array
  invocationSigner: ISigner
}): Promise<Response> {
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method: 'PUT',
    headers: { date: new Date().toUTCString() },
    invocationSigner,
    capability,
    capabilityAction: 'PUT',
    body
  })
  // Send the exact signed bytes -- fetch's `BodyInit` typing rejects a bare
  // `Uint8Array<ArrayBufferLike>` (a lib variance quirk), so cast; the explicit
  // `content-type` set in `signatureHeaders` stands.
  return fetch(url, {
    method: 'PUT',
    headers: signatureHeaders as Record<string, string>,
    body: body as unknown as BodyInit
  })
}

/**
 * Resolves a signed request to its HTTP status and (for a problem response) its
 * error `type`, whether the underlying client fulfills or rejects. The ezcap
 * client throws on a non-2xx, carrying the status and parsed body on the error.
 *
 * @param promise {Promise<any>}   a signed-request promise
 * @returns {Promise<{ status: number; type?: string }>}
 */
async function resolveStatus(
  promise: Promise<any>
): Promise<{ status: number; type?: string }> {
  try {
    const response = await promise
    return { status: response.status, type: response.data?.type }
  } catch (err: any) {
    return {
      status: err.response?.status ?? err.status ?? 0,
      type: err.data?.type
    }
  }
}

export const chunksApi: Suite<State> = {
  id: 'chunks-api',
  name: 'Chunked Resources API',
  specRefs: ['https://w3id.org/pws/encrypted-collections#chunked-resources'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    const spaceId = ctx.generateId()
    alice.space1 = {
      id: spaceId,
      url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Chunk Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    function chunkUrl({
      collectionId,
      resourceId,
      index
    }: {
      collectionId: string
      resourceId: string
      index: number | string
    }): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}/chunks/${index}`,
        ctx.serverUrl
      ).toString()
    }

    function chunksListUrl({
      collectionId,
      resourceId
    }: {
      collectionId: string
      resourceId: string
    }): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}/chunks/`,
        ctx.serverUrl
      ).toString()
    }

    function resourceUrl({
      collectionId,
      resourceId
    }: {
      collectionId: string
      resourceId: string
    }): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
        ctx.serverUrl
      ).toString()
    }

    // A plaintext Collection for the bulk of the round-trip cases.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'data', name: 'Chunked Data' }
    })
    // An encrypted (`edv`) Collection for the "chunk bytes are never parsed,
    // even under an encryption descriptor" rule.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'vault', name: 'Vault', encryption: { scheme: 'edv' } }
    })

    // Listing the Encrypted Collections profile is the claim that the chunk
    // endpoints are served; a server that lists no entry serves none.
    const chunkedSupported = await servesSpec({
      serverUrl: ctx.serverUrl,
      specIdentifier: ENCRYPTED_COLLECTIONS_IDENTIFIER
    })

    async function createParent(resourceId: string): Promise<void> {
      await alice.rootClient.request({
        url: resourceUrl({ collectionId: 'data', resourceId }),
        method: 'PUT',
        action: 'PUT',
        json: { id: resourceId, name: 'Parent Manifest' }
      })
    }

    return {
      alice,
      bob,
      chunkedSupported,
      chunkUrl,
      chunksListUrl,
      resourceUrl,
      createParent
    }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'chunks.roundtrip-put-get-head-delete',
      name: '[root] PUT / GET / HEAD / DELETE a raw octet-stream chunk round-trips',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#store-chunk-operation',
        'https://w3id.org/pws/encrypted-collections#read-chunk-operation',
        'https://w3id.org/pws/encrypted-collections#delete-chunk-operation'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, chunkedSupported, createParent } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'binary-blob'
        await createParent(resourceId)
        const url = chunkUrl({ collectionId: 'data', resourceId, index: 0 })
        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])

        // Store: raw bytes upsert returns 204 carrying the chunk's own ETag.
        const putResponse = await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          body: bytes
        })
        assert.equal(putResponse.status, 204)
        assert.ok(
          putResponse.headers.get('etag'),
          'expected the chunk write to return an ETag'
        )

        // Read: the exact stored bytes come back under their stored content
        // type (a byte-array body is stored as application/octet-stream).
        const getResponse = await alice.rootClient.request({
          url,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.match(
          getResponse.headers.get('content-type') ?? '',
          /application\/octet-stream/
        )
        assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), bytes)

        // Head: the same payload headers, no body.
        const headResponse = await alice.rootClient.request({
          url,
          method: 'HEAD'
        })
        assert.equal(headResponse.status, 200)
        assert.match(
          headResponse.headers.get('content-type') ?? '',
          /application\/octet-stream/
        )
        assert.equal(
          headResponse.headers.get('content-length'),
          String(bytes.length)
        )
        assert.equal(await headResponse.text(), '')

        // Delete: 204, and the chunk is then gone (a later read is 404).
        const deleteResponse = await alice.rootClient.request({
          url,
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)
        assert.equal(
          (
            await resolveStatus(
              alice.rootClient.request({ url, method: 'GET' })
            )
          ).status,
          404
        )
      }
    },
    {
      id: 'chunks.non-canonical-index-invalid-id',
      name: '[root] a non-canonical {index} is rejected with 400 invalid-id',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#chunk-address',
        'https://w3id.org/pws#invalid-id'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, chunkedSupported, createParent } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'bad-index'
        await createParent(resourceId)

        // The `{index}` segment MUST be a canonical non-negative decimal: a
        // leading zero, a sign, or a non-integer spelling is rejected up front
        // with invalid-id (400), on both the read and the write path.
        for (const badIndex of ['01', '+1', '-1', '1.5']) {
          const readResult = await resolveStatus(
            alice.rootClient.request({
              url: chunkUrl({
                collectionId: 'data',
                resourceId,
                index: badIndex
              }),
              method: 'GET'
            })
          )
          assert.equal(
            readResult.status,
            400,
            `expected 400 reading chunk index "${badIndex}"`
          )
          assert.equal(
            readResult.type,
            'https://w3id.org/pws#invalid-id',
            `expected invalid-id for chunk index "${badIndex}"`
          )
        }

        // The write path rejects the same way (invalid-id runs before storage).
        const writeResult = await resolveStatus(
          alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index: '01' }),
            method: 'PUT',
            action: 'PUT',
            body: new Uint8Array([1])
          })
        )
        assert.equal(writeResult.status, 400)
        assert.equal(writeResult.type, 'https://w3id.org/pws#invalid-id')
      }
    },
    {
      id: 'chunks.opaque-body-not-parsed',
      name: '[root] a chunk body is stored verbatim and never parsed, even under an encryption descriptor',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#store-chunk-operation',
        'https://w3id.org/pws/encrypted-collections#read-chunk-operation'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, resourceUrl, chunkedSupported } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        // The parent Resource lives in the encrypted `vault` Collection, so its
        // own content MUST be a conforming EDV envelope...
        const resourceId = 'stream-parent'
        await alice.rootClient.request({
          url: resourceUrl({ collectionId: 'vault', resourceId }),
          method: 'PUT',
          action: 'PUT',
          body: new TextEncoder().encode(JSON.stringify(edvDocument)),
          headers: { 'content-type': 'application/json' }
        })

        // ...but the scheme's envelope validation MUST NOT apply to a chunk: a
        // chunk of an encrypted stream is a ciphertext fragment, not an
        // envelope document. Bytes that are not even valid JSON are accepted
        // verbatim and round-trip byte-identical.
        const nonJson = new TextEncoder().encode('{ this is ] not json <<<')
        const url = chunkUrl({ collectionId: 'vault', resourceId, index: 0 })
        const putResponse = await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          body: nonJson
        })
        assert.equal(
          putResponse.status,
          204,
          'a non-JSON chunk MUST be accepted even in an encrypted Collection'
        )

        const getResponse = await alice.rootClient.request({
          url,
          method: 'GET'
        })
        assert.equal(getResponse.status, 200)
        assert.deepEqual(
          new Uint8Array(await getResponse.arrayBuffer()),
          nonJson
        )
      }
    },
    {
      id: 'chunks.put-missing-parent-404',
      name: '[root] a chunk PUT to a missing parent Resource is rejected with 404',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#store-chunk-operation'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, chunkedSupported } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        // No parent Resource was created: the parent MUST already exist, so a
        // chunk can never be orphaned.
        const result = await resolveStatus(
          alice.rootClient.request({
            url: chunkUrl({
              collectionId: 'data',
              resourceId: 'never-created',
              index: 0
            }),
            method: 'PUT',
            action: 'PUT',
            body: new Uint8Array([9])
          })
        )
        assert.equal(result.status, 404)
      }
    },
    {
      id: 'chunks.delete-absent-not-idempotent',
      name: '[root] deleting an absent chunk is 404 (not idempotent), unlike Delete Resource',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#delete-chunk-operation'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, chunkedSupported, createParent } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'delete-absent'
        await createParent(resourceId)
        // Unlike a Resource delete, a chunk delete is deliberately not
        // idempotent: deleting a chunk that was never written is a 404, so a
        // reassembling reader can tell "gone" from "never written".
        const result = await resolveStatus(
          alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index: 0 }),
            method: 'DELETE'
          })
        )
        assert.equal(result.status, 404)
      }
    },
    {
      id: 'chunks.list-reflects-stored-and-empty',
      name: '[root] the chunk listing reports stored chunks in index order with their ETags, and count 0 once emptied',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#list-chunks-operation'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          chunkUrl,
          chunksListUrl,
          chunkedSupported,
          createParent
        } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'multi-chunk'
        await createParent(resourceId)
        const listUrl = chunksListUrl({ collectionId: 'data', resourceId })

        // A Resource that exists but has no chunks lists as count 0.
        const emptyListing = await alice.rootClient.request({
          url: listUrl,
          method: 'GET'
        })
        assert.equal(emptyListing.status, 200)
        assert.match(
          emptyListing.headers.get('content-type') ?? '',
          /application\/json/
        )
        assert.equal(emptyListing.data.resourceId, resourceId)
        assert.equal(emptyListing.data.count, 0)
        assert.deepEqual(emptyListing.data.chunks, [])

        // Write three chunks out of order to prove the listing sorts by index.
        const chunkBytes = [
          new Uint8Array([1]),
          new Uint8Array([2, 2]),
          new Uint8Array([3, 3, 3])
        ]
        const putEtags: Record<number, string> = {}
        for (const index of [2, 0, 1]) {
          const response = await alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index }),
            method: 'PUT',
            action: 'PUT',
            body: chunkBytes[index]
          })
          assert.equal(response.status, 204)
          putEtags[index] = response.headers.get('etag') ?? ''
        }

        const listing = await alice.rootClient.request({
          url: listUrl,
          method: 'GET'
        })
        assert.equal(listing.status, 200)
        assert.equal(listing.data.count, 3)
        assert.deepEqual(
          listing.data.chunks.map((chunk: { index: number }) => chunk.index),
          [0, 1, 2]
        )
        assert.deepEqual(
          listing.data.chunks.map((chunk: { size: number }) => chunk.size),
          [1, 2, 3]
        )
        for (const chunk of listing.data.chunks) {
          assert.equal(chunk.contentType, 'application/octet-stream')
          // Each entry carries the chunk's own ETag: the one its write
          // returned and its GET and HEAD serve, so a client can pin a
          // DELETE of a listed chunk with If-Match without a read per chunk.
          assert.equal(typeof chunk.etag, 'string')
          assert.equal(chunk.etag, putEtags[chunk.index])
          const url = chunkUrl({
            collectionId: 'data',
            resourceId,
            index: chunk.index
          })
          const getResponse = await alice.rootClient.request({
            url,
            method: 'GET'
          })
          assert.equal(getResponse.headers.get('etag'), chunk.etag)
          const headResponse = await alice.rootClient.request({
            url,
            method: 'HEAD'
          })
          assert.equal(headResponse.headers.get('etag'), chunk.etag)
        }

        // A listed ETag pins a delete: one pinned on another entry's ETag is
        // refused with 412, and one pinned on the entry's own succeeds.
        let staleError: any
        try {
          await alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index: 0 }),
            method: 'DELETE',
            headers: { 'if-match': listing.data.chunks[1].etag }
          })
        } catch (err) {
          staleError = err
        }
        assert.ok(staleError, 'expected the stale pinned delete to fail')
        assert.equal(staleError.response.status, 412)

        // Deleting every chunk, each pinned on its listed ETag, returns the
        // listing to count 0 (the parent Resource still exists, so the
        // container still lists).
        for (const chunk of listing.data.chunks) {
          const deleted = await alice.rootClient.request({
            url: chunkUrl({
              collectionId: 'data',
              resourceId,
              index: chunk.index
            }),
            method: 'DELETE',
            headers: { 'if-match': chunk.etag }
          })
          assert.equal(deleted.status, 204)
        }
        const afterDelete = await alice.rootClient.request({
          url: listUrl,
          method: 'GET'
        })
        assert.equal(afterDelete.status, 200)
        assert.equal(afterDelete.data.count, 0)
        assert.deepEqual(afterDelete.data.chunks, [])
      }
    },
    {
      id: 'chunks.parent-delete-cascade',
      name: '[root] deleting the parent Resource cascades: its chunks and listing become 404',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#chunked-resources',
        'https://w3id.org/pws#delete-resource-operation'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          chunkUrl,
          chunksListUrl,
          resourceUrl,
          chunkedSupported,
          createParent
        } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'cascade'
        await createParent(resourceId)
        for (const index of [0, 1]) {
          await alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index }),
            method: 'PUT',
            action: 'PUT',
            body: new Uint8Array([index])
          })
        }

        const deleted = await alice.rootClient.request({
          url: resourceUrl({ collectionId: 'data', resourceId }),
          method: 'DELETE'
        })
        assert.equal(deleted.status, 204)

        // The previously stored chunk is gone, and the listing 404s (its parent
        // Resource -- and therefore its `chunks/` container -- no longer exists).
        assert.equal(
          (
            await resolveStatus(
              alice.rootClient.request({
                url: chunkUrl({ collectionId: 'data', resourceId, index: 0 }),
                method: 'GET'
              })
            )
          ).status,
          404
        )
        assert.equal(
          (
            await resolveStatus(
              alice.rootClient.request({
                url: chunksListUrl({ collectionId: 'data', resourceId }),
                method: 'GET'
              })
            )
          ).status,
          404
        )
      }
    },
    {
      id: 'chunks.invisible-to-changes-feed',
      name: '[root] chunk writes and deletes do not surface on the collection changes feed',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#store-chunk-operation',
        'https://w3id.org/pws/encrypted-collections#list-chunks-operation'
      ],
      run: async (ctx, state) => {
        const { alice, chunkUrl, resourceUrl, chunkedSupported } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'feed-manifest'
        const queryUrl = new URL(
          `/space/${alice.space1.id}/data/query`,
          ctx.serverUrl
        ).toString()

        // Seed the parent manifest, then drain the feed and keep a checkpoint.
        await alice.rootClient.request({
          url: resourceUrl({ collectionId: 'data', resourceId }),
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId, sequence: 0 }
        })
        const initial = await alice.rootClient.request({
          url: queryUrl,
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100 }
        })
        assert.equal(initial.status, 200)
        assert.ok(
          initial.data.documents.some(
            (document: { kind: string; id: string }) =>
              document.kind === 'resource' && document.id === resourceId
          ),
          'expected the seeded manifest in the initial feed'
        )
        const checkpoint = initial.data.checkpoint

        // A chunk write and a chunk delete advance only the chunk's own ETag:
        // neither MUST touch the parent Resource's feed position.
        for (const index of [0, 1]) {
          await alice.rootClient.request({
            url: chunkUrl({ collectionId: 'data', resourceId, index }),
            method: 'PUT',
            action: 'PUT',
            body: new Uint8Array([index])
          })
        }
        await alice.rootClient.request({
          url: chunkUrl({ collectionId: 'data', resourceId, index: 1 }),
          method: 'DELETE'
        })

        const afterChunks = await alice.rootClient.request({
          url: queryUrl,
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100, checkpoint }
        })
        assert.equal(afterChunks.status, 200)
        assert.deepEqual(
          afterChunks.data.documents,
          [],
          'chunk writes MUST NOT surface on the changes feed'
        )

        // A subsequent parent-manifest PUT is what surfaces the change: the
        // feed reacts to the Resource, not to its chunks.
        await alice.rootClient.request({
          url: resourceUrl({ collectionId: 'data', resourceId }),
          method: 'PUT',
          action: 'PUT',
          json: { id: resourceId, sequence: 1 }
        })
        const afterManifest = await alice.rootClient.request({
          url: queryUrl,
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100, checkpoint }
        })
        assert.deepEqual(
          afterManifest.data.documents.map(
            (document: { id: string }) => document.id
          ),
          [resourceId]
        )
      }
    },
    {
      id: 'chunks.write-cap-bound-to-chunk-url',
      name: '[delegated] a capability for one chunk cannot write a sibling chunk',
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#chunk-authorization',
        'https://w3id.org/pws/encrypted-collections#store-chunk-operation'
      ],
      run: async (ctx, state) => {
        const { alice, bob, chunkUrl, chunkedSupported, createParent } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'target-binding'
        await createParent(resourceId)
        const chunkZeroUrl = chunkUrl({
          collectionId: 'data',
          resourceId,
          index: 0
        })
        const chunkOneUrl = chunkUrl({
          collectionId: 'data',
          resourceId,
          index: 1
        })

        // A chunk-write capability's `invocationTarget` is the chunk's own full
        // URL. Alice grants Bob a PUT capability on chunk index 1's URL; invoked
        // against chunk index 0 -- a sibling, not the same URL and not an
        // ancestor of it -- the capability does not authorize the write, so the
        // server rejects the invocation without performing it. (The reference
        // server permits an ancestor-scoped capability to attenuate down to a
        // descendant, so the binding is probed with a non-ancestor sibling.)
        const zcap = await alice.was.grant({
          to: bob.did,
          actions: ['PUT'],
          target: chunkOneUrl,
          spaceUrl: alice.space1.url
        })
        const response = await writeChunkAt({
          url: chunkZeroUrl,
          capability: zcap,
          body: new Uint8Array([7]),
          invocationSigner: bob.rootClient.invocationSigner
        })
        assert.ok(
          response.status === 400 || response.status === 404,
          `expected the sibling-chunk invocation to be rejected with ` +
            `400 or 404, got ${response.status}`
        )
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/problem\+json/
        )

        // The operation MUST NOT have been performed: chunk 0 was not written.
        assert.equal(
          (
            await resolveStatus(
              alice.rootClient.request({ url: chunkZeroUrl, method: 'GET' })
            )
          ).status,
          404
        )
      }
    },
    {
      id: 'chunks.no-leak-foreign-controller-404',
      name: "[cross-controller] Bob reading or writing Alice's chunk URL is masked as 404",
      specRefs: [
        'https://w3id.org/pws/encrypted-collections#chunk-authorization',
        'https://w3id.org/pws#error-handling'
      ],
      run: async (ctx, state) => {
        const { alice, bob, chunkUrl, chunkedSupported, createParent } = state
        if (!chunkedSupported) {
          ctx.skip('the server lists no Encrypted Collections entry')
        }
        const resourceId = 'foreign'
        await createParent(resourceId)
        const url = chunkUrl({ collectionId: 'data', resourceId, index: 0 })
        // Alice stores a chunk Bob has no authority over.
        await alice.rootClient.request({
          url,
          method: 'PUT',
          action: 'PUT',
          body: new Uint8Array([1, 2, 3])
        })

        // Bob root-invokes against Alice's chunk URL: the synthesized root
        // capability is controlled by Alice, so Bob's signature does not verify
        // and, per the maximum-privacy rule, both the read and the write are
        // masked as 404 rather than disclosing the chunk's existence.
        assert.equal(
          (await resolveStatus(bob.rootClient.request({ url, method: 'GET' })))
            .status,
          404
        )
        assert.equal(
          (
            await resolveStatus(
              bob.rootClient.request({
                url,
                method: 'PUT',
                action: 'PUT',
                body: new Uint8Array([9])
              })
            )
          ).status,
          404
        )

        // Alice's chunk is untouched.
        const readBack = await alice.rootClient.request({ url, method: 'GET' })
        assert.deepEqual(
          new Uint8Array(await readBack.arrayBuffer()),
          new Uint8Array([1, 2, 3])
        )
      }
    }
  ]
}
