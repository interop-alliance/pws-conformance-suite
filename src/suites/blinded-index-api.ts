/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- the `blinded-index` query profile (matching over
 * client-computed blinded / HMAC'd attributes, served at
 * `POST /space/:s/:c/query`; spec "Query Profile Registry").
 *
 * The profile is OPTIONAL, advertised by the `blinded-index-query` token of the
 * Encrypted Collections entry in the service description. This suite is
 * therefore NOT suite-level optional -- once a server advertises the token, the
 * profile's MUSTs are required-tier. `setup()` reads that document; when the
 * token is absent, every test calls `ctx.skip(...)`.
 *
 * The stored documents are EDV encrypted-document envelopes whose `indexed`
 * attributes stand in for the client's HMAC-blinded base64url tokens -- the
 * server matches them opaquely, so no real crypto is exercised here. Signed
 * queries and writes use the raw `ZcapClient.request()` escape hatch, like the
 * sibling `changes` profile suite.
 *
 * The `codec path` group is the counterpart to that: instead of hand-built
 * envelopes it drives `@interop/was-client`'s EDV codec -- a collection
 * provisioned with a blinding key, an attribute declared searchable, documents
 * written with `add()` and matched with `find()`. That is what proves the
 * tokens a real client computes are the tokens this server matches, which
 * hand-built fixtures cannot show.
 */
import assert from '../harness/assert.js'
import {
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  serviceFeatures
} from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

import { ConflictError, WasClient } from '@interop/was-client'
import type { Collection, FindPage, Space } from '@interop/was-client'
import {
  createEdvEncryption,
  ensureFirstEpoch,
  ownerRecipient
} from '@interop/was-client/edv'
import type { IKeyAgreementKey } from '@interop/data-integrity-core'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

/** The (opaque) HMAC key id every seeded envelope indexes under. */
const HMAC_ID = 'did:key:zHmacBlindedIndexKeyA'

/** The label of the group whose fixtures the was-client codec writes. */
const CODEC_GROUP = 'codec path'

interface State {
  alice: any
  bob: any
  advertised: boolean
  queryUrl: (collectionId: string) => string
  resourceUrl: (collectionId: string, resourceId: string) => string
  /** Set by the `codec path` group setup, when the feature is advertised. */
  codec?: {
    space: Space
    searchable: Collection
    unique: Collection
  }
}

/**
 * Builds a stored EDV encrypted-document envelope carrying one blinded
 * `indexed` entry (structurally what `@interop/edv-client` produces). Each
 * attribute's `name` / `value` is an opaque blinded token; `unique` marks a
 * uniqueness claim.
 *
 * @param options {object}
 * @param options.id {string}   the document (Resource) id
 * @param options.attributes {Array<{ name: string, value: string, unique?: boolean }>}
 * @returns {object}   the envelope document
 */
function envelope({
  id,
  attributes
}: {
  id: string
  attributes: Array<{ name: string; value: string; unique?: boolean }>
}): Record<string, unknown> {
  return {
    id,
    sequence: 0,
    indexed: [
      {
        hmac: { id: HMAC_ID, type: 'Sha256HmacKey2019' },
        sequence: 0,
        attributes
      }
    ],
    jwe: {
      protected: 'eyJlbmMiOiJYQzIwUCJ9',
      iv: 'aXY',
      ciphertext: 'Y2lwaGVydGV4dA',
      tag: 'dGFn'
    }
  }
}

/**
 * Builds an encryption-capable WAS client over a fresh Ed25519 signer, plus
 * the X25519 key-agreement key the collection's first epoch (and its blinding
 * key) wraps to. The suite's shared actors carry plaintext clients only, so the
 * codec-path group needs its own identity and keystore.
 *
 * @param options {object}
 * @param options.serverUrl {string}   the server under test
 * @returns {Promise<{ was: WasClient, keyAgreementKey: IKeyAgreementKey }>}
 */
async function encryptedClient({ serverUrl }: { serverUrl: string }): Promise<{
  was: WasClient
  keyAgreementKey: IKeyAgreementKey
}> {
  const keyPair = await Ed25519VerificationKey.generate()
  const did = `did:key:${keyPair.fingerprint()}`

  const kak = await X25519KeyAgreementKey2020.generate({ controller: did })
  const keyResolver = async ({ id }: { id?: string }) => {
    if (id !== kak.id) {
      throw new Error(`Unknown key id "${id}".`)
    }
    return {
      id: kak.id,
      type: kak.type,
      publicKeyMultibase: kak.publicKeyMultibase
    }
  }
  const keyAgreementKey = kak as IKeyAgreementKey
  const encryption = createEdvEncryption({
    resolveKeys: async () => ({ keyAgreementKey, keyResolver })
  })
  return {
    was: WasClient.fromSigner({
      baseServerUrl: serverUrl,
      signer: keyPair.didKeySigner(),
      encryption
    }),
    keyAgreementKey
  }
}

export const blindedIndexApi: Suite<State> = {
  id: 'blinded-index-api',
  name: 'Blinded-index query profile',
  specRefs: [
    'https://w3id.org/pws#query-profile-blinded-index',
    'https://w3id.org/pws#query-profile-registry'
  ],

  setup: async ctx => {
    // Shallow-clone the shared actors so per-suite scratch fields do not leak.
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }

    /** Absolute URL for a Collection's reserved `/query` endpoint. */
    function queryUrl(collectionId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/query`,
        ctx.serverUrl
      ).toString()
    }

    /** Absolute URL for a Resource within a Collection. */
    function resourceUrl(collectionId: string, resourceId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
        ctx.serverUrl
      ).toString()
    }

    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Blinded-Index Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    const features = await serviceFeatures({
      serverUrl: ctx.serverUrl,
      specIdentifier: ENCRYPTED_COLLECTIONS_IDENTIFIER
    })
    const advertised = features.includes('blinded-index-query')

    // Seed fixtures only when the feature is supported; otherwise every test
    // skips and nothing needs to be provisioned.
    if (advertised) {
      // Creates a Collection and PUTs each envelope at its id.
      async function seedCollection(
        collectionId: string,
        documents: Array<Record<string, unknown>>
      ): Promise<void> {
        await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: collectionId }
        })
        for (const document of documents) {
          await alice.rootClient.request({
            url: resourceUrl(collectionId, document.id as string),
            method: 'PUT',
            action: 'PUT',
            json: document
          })
        }
      }

      // The main fixture: `alpha` and `beta` share the `n1:v1` term; only
      // `alpha` also carries `n2:v2`; `gamma` differs on value.
      await seedCollection('vault', [
        envelope({
          id: 'alpha',
          attributes: [
            { name: 'n1', value: 'v1' },
            { name: 'n2', value: 'v2' }
          ]
        }),
        envelope({ id: 'beta', attributes: [{ name: 'n1', value: 'v1' }] }),
        envelope({ id: 'gamma', attributes: [{ name: 'n1', value: 'vX' }] })
      ])

      // A uniqueness-claim fixture: `holder` claims the `un1:uv1` triple.
      await seedCollection('vault-unique', [
        envelope({
          id: 'holder',
          attributes: [{ name: 'un1', value: 'uv1', unique: true }]
        })
      ])
    }

    return { alice, bob, advertised, queryUrl, resourceUrl }
  },

  teardown: async (ctx, state) => {
    const { alice, codec } = state
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
    try {
      await codec?.space.delete()
    } catch {
      /* best-effort cleanup */
    }
  },

  groups: [
    {
      name: CODEC_GROUP,
      setup: async (ctx, state) => {
        if (!state.advertised) {
          return
        }
        // A Space of its own, controlled by the encrypting client's DID: the
        // shared actors' clients hold no keys, so they cannot write here.
        const { was, keyAgreementKey } = await encryptedClient({
          serverUrl: ctx.serverUrl
        })
        const space = await ctx.provisionSpace({
          was,
          name: 'Blinded Codec Space'
        })

        /**
         * Provisions an encrypted, searchable Collection and declares one
         * attribute on it. The blinding key installs with epoch[0] or never,
         * so `blindedIndex` is asked for at provisioning time.
         *
         * @param options {object}
         * @param options.id {string}   the Collection id
         * @param options.attribute {string}   the dotted attribute path
         * @param [options.unique] {boolean}   claim the value exclusively
         * @returns {Promise<Collection>}
         */
        async function searchableCollection({
          id,
          attribute,
          unique
        }: {
          id: string
          attribute: string
          unique?: boolean
        }): Promise<Collection> {
          const declared = await space.createCollection({
            id,
            encryption: { scheme: 'edv' }
          })
          await ensureFirstEpoch({
            collection: declared,
            recipients: [ownerRecipient({ keyAgreementKey })],
            blindedIndex: true
          })
          const collection = was.spaceAt(space.url).collection(id)
          await collection.declareIndex({
            attribute,
            ...(unique && { unique })
          })
          return collection
        }

        const searchable = await searchableCollection({
          id: 'codec-vault',
          attribute: 'content.type'
        })
        // Two `note`s and one `task`: enough to tell a match from a non-match.
        await searchable.add({ type: 'note', title: 'alpha' })
        await searchable.add({ type: 'note', title: 'beta' })
        await searchable.add({ type: 'task', title: 'gamma' })

        const unique = await searchableCollection({
          id: 'codec-vault-unique',
          attribute: 'content.serial',
          unique: true
        })
        await unique.add({ serial: 'serial-1', title: 'holder' })

        state.codec = { space, searchable, unique }
      }
    }
  ],

  tests: [
    {
      id: 'blinded.equals-match-ascending',
      name: '[root] equals matches documents by blinded term, ascending by id',
      specRefs: ['https://w3id.org/pws#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }]
          }
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        // `alpha` and `beta` carry `n1:v1`; `gamma` does not. Order is the
        // spec-mandated ascending Resource id.
        assert.deepEqual(
          response.data.documents.map((doc: any) => doc.id),
          ['alpha', 'beta']
        )
        assert.equal(response.data.hasMore, false)
        // `cursor` is present if and only if `hasMore` is true.
        assert.equal(response.data.cursor, undefined)
        // The stored envelope round-trips verbatim.
        assert.deepEqual(
          response.data.documents[1],
          envelope({ id: 'beta', attributes: [{ name: 'n1', value: 'v1' }] })
        )
      }
    },
    {
      id: 'blinded.has-match',
      name: '[root] has matches documents carrying every named blinded attribute',
      specRefs: ['https://w3id.org/pws#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        // Only `alpha` carries both `n1` and `n2`.
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            has: ['n1', 'n2']
          }
        })
        assert.equal(response.status, 200)
        assert.deepEqual(
          response.data.documents.map((doc: any) => doc.id),
          ['alpha']
        )
      }
    },
    {
      id: 'blinded.count-shape',
      name: '[root] count:true returns exactly a { count } shape',
      specRefs: ['https://w3id.org/pws#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        // `n1:v1` (alpha, beta) OR `n1:vX` (gamma) matches all three.
        const response = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }, { n1: 'vX' }],
            count: true
          }
        })
        assert.equal(response.status, 200)
        assert.deepEqual(response.data, { count: 3 })
      }
    },
    {
      id: 'blinded.pagination-cursor',
      name: '[root] a limited page pairs hasMore with an opaque continuation cursor',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#query-profile-blinded-index',
        'https://w3id.org/pws#pagination'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        const firstPage = await alice.rootClient.request({
          url: queryUrl('vault'),
          method: 'POST',
          action: 'POST',
          json: {
            profile: 'blinded-index',
            index: HMAC_ID,
            equals: [{ n1: 'v1' }],
            limit: 1
          }
        })
        assert.equal(firstPage.status, 200)
        // `cursor` is present if and only if `hasMore` is true, whether or not
        // the server honored the small `limit` (clamping down is permitted).
        if (firstPage.data.hasMore === true) {
          assert.ok(
            firstPage.data.cursor,
            'a non-final page must carry a continuation cursor'
          )
          assert.deepEqual(
            firstPage.data.documents.map((doc: any) => doc.id),
            ['alpha']
          )
          const secondPage = await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              equals: [{ n1: 'v1' }],
              limit: 1,
              cursor: firstPage.data.cursor
            }
          })
          assert.deepEqual(
            secondPage.data.documents.map((doc: any) => doc.id),
            ['beta']
          )
          assert.equal(secondPage.data.hasMore, false)
          assert.equal(secondPage.data.cursor, undefined)
        } else {
          // Lenient `limit`: the whole result was returned in one page.
          assert.equal(firstPage.data.cursor, undefined)
          assert.deepEqual(
            firstPage.data.documents.map((doc: any) => doc.id),
            ['alpha', 'beta']
          )
        }
      }
    },
    {
      id: 'blinded.invalid-query-body-400',
      name: '[root] a body with neither, or both, of equals/has is invalid-request-body (400)',
      specRefs: [
        'https://w3id.org/pws#query-profile-blinded-index',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }

        // Neither `equals` nor `has`.
        let neitherError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: { profile: 'blinded-index', index: HMAC_ID }
          })
        } catch (err) {
          neitherError = err
        }
        assert.ok(neitherError, 'expected a body with neither clause to fail')
        assert.equal(neitherError.response.status, 400)
        assert.match(
          neitherError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(
          neitherError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )

        // Both `equals` and `has`.
        let bothError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              equals: [{ n1: 'v1' }],
              has: ['n1']
            }
          })
        } catch (err) {
          bothError = err
        }
        assert.ok(bothError, 'expected a body with both clauses to fail')
        assert.equal(bothError.response.status, 400)
        assert.equal(
          bothError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )

        // Missing the REQUIRED `index`.
        let missingIndexError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: { profile: 'blinded-index', has: ['n1'] }
          })
        } catch (err) {
          missingIndexError = err
        }
        assert.ok(missingIndexError, 'expected a body missing index to fail')
        assert.equal(missingIndexError.response.status, 400)
        assert.equal(
          missingIndexError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'blinded.invalid-cursor-400',
      name: '[root] a malformed continuation cursor is invalid-cursor (400)',
      specRefs: [
        'https://w3id.org/pws#query-profile-blinded-index',
        'https://w3id.org/pws#invalid-cursor'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, queryUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        let cursorError: any
        try {
          await alice.rootClient.request({
            url: queryUrl('vault'),
            method: 'POST',
            action: 'POST',
            json: {
              profile: 'blinded-index',
              index: HMAC_ID,
              has: ['n1'],
              cursor: 'not!!a-valid-cursor'
            }
          })
        } catch (err) {
          cursorError = err
        }
        assert.ok(cursorError, 'expected a malformed cursor to be rejected')
        assert.equal(cursorError.response.status, 400)
        assert.equal(
          cursorError.data.type,
          'https://w3id.org/pws#invalid-cursor'
        )
      }
    },
    {
      id: 'blinded.unique-conflict-409',
      name: '[root] a write claiming a held unique blinded triple is id-conflict (409)',
      specRefs: [
        'https://w3id.org/pws#unique-blinded-attributes',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const { alice, advertised, resourceUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        // `holder` already claims `un1:uv1` with unique:true; a different
        // Resource claiming the same triple must be rejected.
        let conflictError: any
        try {
          await alice.rootClient.request({
            url: resourceUrl('vault-unique', 'claimant'),
            method: 'PUT',
            action: 'PUT',
            json: envelope({
              id: 'claimant',
              attributes: [{ name: 'un1', value: 'uv1', unique: true }]
            })
          })
        } catch (err) {
          conflictError = err
        }
        assert.ok(
          conflictError,
          'expected the conflicting claim to be rejected'
        )
        assert.equal(conflictError.response.status, 409)
        assert.equal(
          conflictError.data.type,
          'https://w3id.org/pws#id-conflict'
        )

        // The same pair carried WITHOUT `unique` coexists freely (both-sides
        // rule): this write succeeds.
        const coexisting = await alice.rootClient.request({
          url: resourceUrl('vault-unique', 'bystander'),
          method: 'PUT',
          action: 'PUT',
          json: envelope({
            id: 'bystander',
            attributes: [{ name: 'un1', value: 'uv1' }]
          })
        })
        assert.ok([200, 201, 204].includes(coexisting.status))
      }
    },
    {
      id: 'blinded.authz-before-uniqueness-404',
      name: "[root] Bob's write of a held unique triple into Alice's collection is 404, not 409",
      specRefs: [
        'https://w3id.org/pws#unique-blinded-attributes',
        'https://w3id.org/pws#error-type-registry',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { bob, advertised, resourceUrl } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        // Authorization MUST be verified before the uniqueness check: a 409
        // here would let Bob probe Alice's Collection for held unique triples.
        let maskedError: any
        try {
          await bob.rootClient.request({
            url: resourceUrl('vault-unique', 'intruder'),
            method: 'PUT',
            action: 'PUT',
            json: envelope({
              id: 'intruder',
              attributes: [{ name: 'un1', value: 'uv1', unique: true }]
            })
          })
        } catch (err) {
          maskedError = err
        }
        assert.ok(maskedError, "expected Bob's write to be rejected")
        assert.equal(maskedError.response.status, 404)
        assert.match(
          maskedError.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(maskedError.data.type, 'https://w3id.org/pws#not-found')
      }
    },
    {
      id: 'blinded.codec-equals-roundtrip',
      name: 'codec-written documents match on equals and round-trip decrypted',
      group: CODEC_GROUP,
      specRefs: [
        'https://w3id.org/pws#query-profile-blinded-index',
        'https://w3id.org/pws#encryption-scheme-registry'
      ],
      run: async (ctx, state) => {
        const { advertised, codec } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        assert.ok(codec, 'expected the codec-path fixtures')
        // The tokens are computed by the client's blinding key, so a match
        // here is the end-to-end proof the two sides agree on the encoding.
        const page = (await codec.searchable.find({
          equals: { 'content.type': 'note' }
        })) as FindPage
        const titles = page.items
          .map(item => (item.data as { title: string }).title)
          .sort()
        assert.deepEqual(titles, ['alpha', 'beta'])
        assert.equal(page.hasMore, false)
      }
    },
    {
      id: 'blinded.codec-has-and-count',
      name: 'codec-written documents match on has, and count returns just the tally',
      group: CODEC_GROUP,
      specRefs: ['https://w3id.org/pws#query-profile-blinded-index'],
      run: async (ctx, state) => {
        const { advertised, codec } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        assert.ok(codec, 'expected the codec-path fixtures')
        // Every document carries the declared attribute, whatever its value.
        const page = (await codec.searchable.find({
          has: 'content.type'
        })) as FindPage
        assert.equal(page.items.length, 3)

        const counted = await codec.searchable.find({
          equals: { 'content.type': 'task' },
          count: true
        })
        assert.deepEqual(counted, { count: 1 })
      }
    },
    {
      id: 'blinded.codec-unique-conflict',
      name: 'a codec write colliding on a unique declared attribute is id-conflict (409)',
      group: CODEC_GROUP,
      specRefs: [
        'https://w3id.org/pws#unique-blinded-attributes',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const { advertised, codec } = state
        if (!advertised) {
          ctx.skip('the server does not advertise blinded-index-query')
        }
        assert.ok(codec, 'expected the codec-path fixtures')
        // `content.serial` is declared unique, so the codec stamps its blinded
        // entry with `unique: true` and a second claimant of the same value is
        // refused -- the client surfacing the server's 409 as a ConflictError.
        let conflictError: any
        try {
          await codec.unique.add({ serial: 'serial-1', title: 'claimant' })
        } catch (err) {
          conflictError = err
        }
        assert.ok(conflictError, 'expected the colliding write to be rejected')
        assert.ok(
          conflictError instanceof ConflictError,
          `expected a ConflictError, got ${conflictError?.name}`
        )
        assert.equal(conflictError.status, 409)

        // A different value under the same unique attribute still writes.
        const { id } = await codec.unique.add({
          serial: 'serial-2',
          title: 'other'
        })
        assert.ok(id, 'expected the non-colliding write to succeed')
      }
    }
  ]
}
