/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- the Collection `plaintext` member and its `indexes`
 * declaration (server-side plaintext indexing for the `equality` query
 * profile). `plaintext` is the counterpart of `encryption`: at most one of the
 * two is present on a Collection Metadata object, by presence, so an empty
 * `plaintext` object still excludes `encryption`. Unlike the set-once
 * `encryption`, `plaintext` is updatable for the Collection's life; `{}` is
 * its empty state.
 *
 * The suite is optional until the spec text for `plaintext` and the `equality`
 * profile is published; the shape is settled by the spec's decision record on
 * plaintext and encryption counterparts.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  collectionUrl: (collectionId: string) => string
  resourceUrl: (collectionId: string, resourceId: string) => string
  createCollection: (json: object) => Promise<any>
  putCollection: (collectionId: string, json: object) => Promise<any>
  readCollection: (collectionId: string) => Promise<any>
}

/**
 * Runs a request expected to fail and returns the thrown error, failing the
 * test when the request unexpectedly succeeds.
 * @param request {Promise<unknown>}
 * @param message {string}
 * @returns {Promise<any>}
 */
async function rejection(request: Promise<unknown>, message: string) {
  let expectedError: any
  try {
    await request
  } catch (err) {
    expectedError = err
  }
  assert.ok(expectedError, message)
  return expectedError
}

export const plaintextDeclarationApi: Suite<State> = {
  id: 'plaintext-declaration-api',
  name: 'Plaintext declaration API',
  optional: true,
  specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],

  setup: async ctx => {
    const { serverUrl } = ctx
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Plaintext Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    function collectionUrl(collectionId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}`,
        serverUrl
      ).toString()
    }
    function resourceUrl(collectionId: string, resourceId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
        serverUrl
      ).toString()
    }
    /** POSTs a Collection (raw, so a `plaintext` member can be sent). */
    function createCollection(json: object): Promise<any> {
      return alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json
      })
    }
    /** PUTs a Collection Metadata object by id (create-by-id or update). */
    function putCollection(collectionId: string, json: object): Promise<any> {
      return alice.rootClient.request({
        url: `${collectionUrl(collectionId)}/meta`,
        method: 'PUT',
        action: 'PUT',
        json
      })
    }
    function readCollection(collectionId: string): Promise<any> {
      return alice.rootClient.request({
        url: `${collectionUrl(collectionId)}/meta`,
        method: 'GET'
      })
    }

    return {
      alice,
      collectionUrl,
      resourceUrl,
      createCollection,
      putCollection,
      readCollection
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
      id: 'plaintext.persist-echo-post',
      name: '[root] persists and echoes plaintext.indexes on POST create and on GET',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { createCollection, readCollection } = state
        const plaintext = {
          indexes: [
            'parentId',
            { name: 'author' },
            { name: 'slug', source: 'content', unique: true }
          ]
        }
        const response = await createCollection({
          id: 'posts',
          name: 'Posts',
          plaintext
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(response.data.plaintext, plaintext)
        assert.equal(response.data.encryption, undefined)

        const read = await readCollection('posts')
        assert.deepStrictEqual(read.data.plaintext, plaintext)
      }
    },
    {
      id: 'plaintext.persist-echo-put',
      name: '[root] persists and echoes plaintext.indexes on PUT create-by-id',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { putCollection, readCollection } = state
        const response = await putCollection('posts-put', {
          id: 'posts-put',
          name: 'Posts (PUT)',
          plaintext: { indexes: ['parentId'] }
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(response.data.plaintext, {
          indexes: ['parentId']
        })
        const read = await readCollection('posts-put')
        assert.deepStrictEqual(read.data.plaintext, { indexes: ['parentId'] })
      }
    },
    {
      id: 'plaintext.both-on-create-400',
      name: '[root] plaintext and encryption both present on create is invalid-request-body (400), even an empty plaintext',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createCollection, putCollection } = state
        const bodies = [
          {
            id: 'both-post',
            plaintext: { indexes: ['parentId'] },
            encryption: { scheme: 'edv' }
          },
          // Exclusion is by presence: an empty `plaintext` still excludes.
          {
            id: 'both-post-empty',
            plaintext: {},
            encryption: { scheme: 'edv' }
          }
        ]
        for (const body of bodies) {
          const postError = await rejection(
            createCollection(body),
            `expected the POST create of ${body.id} to be rejected`
          )
          assert.equal(postError.response.status, 400)
          assert.equal(
            postError.data.type,
            'https://w3id.org/pws#invalid-request-body'
          )
          const putError = await rejection(
            putCollection(body.id, body),
            `expected the PUT create of ${body.id} to be rejected`
          )
          assert.equal(putError.response.status, 400)
          assert.equal(
            putError.data.type,
            'https://w3id.org/pws#invalid-request-body'
          )
        }
      }
    },
    {
      id: 'plaintext.both-on-update-400',
      name: '[root] an update adding plaintext to an encrypted Collection is invalid-request-body (400), even an empty plaintext',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createCollection, putCollection, readCollection } = state
        // Adding `plaintext` (even empty) to an encrypted Collection. `PUT`
        // is a full replacement, so `encryption` is re-sent unchanged (an
        // idempotent no-op) alongside the newly added `plaintext` -- an
        // update that omitted `encryption` instead would be an attempt to
        // clear the set-once descriptor (`encryption-immutable`, 409), a
        // different failure than the one under test here.
        await createCollection({
          id: 'enc-first',
          encryption: { scheme: 'edv' }
        })
        for (const plaintext of [{ indexes: ['parentId'] }, {}]) {
          const err = await rejection(
            putCollection('enc-first', {
              id: 'enc-first',
              encryption: { scheme: 'edv' },
              plaintext
            }),
            'expected adding plaintext to an encrypted Collection to be rejected'
          )
          assert.equal(err.response.status, 400)
          assert.equal(
            err.data.type,
            'https://w3id.org/pws#invalid-request-body'
          )
        }
        const encrypted = await readCollection('enc-first')
        assert.deepStrictEqual(encrypted.data.encryption, { scheme: 'edv' })
        assert.equal(encrypted.data.plaintext, undefined)
      }
    },
    {
      id: 'plaintext.add-encryption-refused',
      name: '[root] an update adding encryption to a plaintext-declared Collection is refused (409 encryption-immutable or 400 invalid-request-body)',
      specRefs: [
        'https://w3id.org/pws#creation-only-members',
        'https://w3id.org/pws#encryption-immutable',
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createCollection, putCollection, readCollection } = state
        // The update omits `plaintext`, which leaves the stored `{}` in place,
        // so its result would carry both members (`invalid-request-body`,
        // 400). It is also a late declaration of the creation-only
        // `encryption` (`encryption-immutable`, 409). The spec sets no order
        // between the two checks, so either refusal is accepted. Either way
        // the stored object must survive intact.
        await createCollection({ id: 'plain-first', plaintext: {} })
        const err = await rejection(
          putCollection('plain-first', {
            id: 'plain-first',
            encryption: { scheme: 'edv' }
          }),
          'expected adding encryption to a plaintext-declared Collection to be rejected'
        )
        const { status } = err.response
        assert.ok(
          status === 409 || status === 400,
          `expected 409 or 400 for the late encryption declaration, got ${status}`
        )
        assert.equal(
          err.data.type,
          status === 409
            ? 'https://w3id.org/pws#encryption-immutable'
            : 'https://w3id.org/pws#invalid-request-body'
        )
        const plain = await readCollection('plain-first')
        assert.deepStrictEqual(plain.data.plaintext, {})
        assert.equal(plain.data.encryption, undefined)
      }
    },
    {
      id: 'plaintext.malformed-400',
      name: '[root] rejects a malformed plaintext member (400 invalid-request-body)',
      specRefs: ['https://w3id.org/pws#invalid-request-body'],
      run: async (ctx, state) => {
        const { createCollection, readCollection } = state
        const malformed: Array<{ label: string; plaintext: unknown }> = [
          { label: 'a non-object plaintext', plaintext: ['parentId'] },
          { label: 'a non-array indexes', plaintext: { indexes: 'parentId' } },
          { label: 'an empty-string entry', plaintext: { indexes: [''] } },
          {
            label: 'an object entry without a name',
            plaintext: { indexes: [{ source: 'content' }] }
          },
          {
            label: 'a duplicate name across sources',
            plaintext: { indexes: ['tag', { name: 'tag', source: 'custom' }] }
          },
          {
            label: 'an unknown source',
            plaintext: { indexes: [{ name: 'x', source: 'elsewhere' }] }
          },
          {
            label: 'a non-boolean unique',
            plaintext: { indexes: [{ name: 'x', unique: 'yes' }] }
          }
        ]
        for (const { label, plaintext } of malformed) {
          const err = await rejection(
            createCollection({ id: 'malformed', plaintext }),
            `expected ${label} to be rejected`
          )
          assert.equal(err.response.status, 400, label)
          assert.equal(
            err.data.type,
            'https://w3id.org/pws#invalid-request-body',
            label
          )
        }
        // None of the rejected creates left a Collection behind.
        const err = await rejection(
          readCollection('malformed'),
          'expected no Collection to exist after the rejected creates'
        )
        assert.equal(err.response.status, 404)
      }
    },
    {
      id: 'plaintext.updatable',
      name: '[root] plaintext is updatable on an existing Collection: added, changed, and emptied with {}; an absent member is left untouched',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { createCollection, putCollection, readCollection } = state
        // Born without `plaintext`.
        await createCollection({ id: 'evolving', name: 'Evolving' })
        let read = await readCollection('evolving')
        assert.equal(read.data.plaintext, undefined)

        // Add.
        await putCollection('evolving', {
          id: 'evolving',
          plaintext: { indexes: ['parentId'] }
        })
        read = await readCollection('evolving')
        assert.deepStrictEqual(read.data.plaintext, { indexes: ['parentId'] })

        // An update that omits `plaintext` leaves it untouched.
        await putCollection('evolving', { id: 'evolving', name: 'Renamed' })
        read = await readCollection('evolving')
        assert.equal(read.data.name, 'Renamed')
        assert.deepStrictEqual(read.data.plaintext, { indexes: ['parentId'] })

        // Change: the supplied object replaces the stored one.
        await putCollection('evolving', {
          id: 'evolving',
          plaintext: { indexes: ['author', { name: 'slug', unique: true }] }
        })
        read = await readCollection('evolving')
        assert.deepStrictEqual(read.data.plaintext, {
          indexes: ['author', { name: 'slug', unique: true }]
        })

        // `{}` is the empty state: still present, no declaration.
        await putCollection('evolving', { id: 'evolving', plaintext: {} })
        read = await readCollection('evolving')
        assert.deepStrictEqual(read.data.plaintext, {})
      }
    },
    {
      id: 'plaintext.unique-conflict-409',
      name: '[root] a write claiming a held unique plaintext attribute value is id-conflict (409)',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const { alice, createCollection, resourceUrl } = state
        await createCollection({
          id: 'unique-slugs',
          plaintext: { indexes: [{ name: 'slug', unique: true }] }
        })
        const holder = await alice.rootClient.request({
          url: resourceUrl('unique-slugs', 'holder'),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'holder', slug: 'hello-world' }
        })
        assert.ok([200, 201, 204].includes(holder.status))

        // A different Resource claiming the same `(slug, 'hello-world')`.
        const conflictError = await rejection(
          alice.rootClient.request({
            url: resourceUrl('unique-slugs', 'claimant'),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'claimant', slug: 'hello-world' }
          }),
          'expected the conflicting claim to be rejected'
        )
        assert.equal(conflictError.response.status, 409)
        assert.equal(
          conflictError.data.type,
          'https://w3id.org/pws#id-conflict'
        )

        // The holder re-asserting its own value never self-conflicts.
        const reassert = await alice.rootClient.request({
          url: resourceUrl('unique-slugs', 'holder'),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'holder', slug: 'hello-world', edited: true }
        })
        assert.ok([200, 201, 204].includes(reassert.status))

        // A different value coexists freely.
        const other = await alice.rootClient.request({
          url: resourceUrl('unique-slugs', 'other'),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'other', slug: 'second-post' }
        })
        assert.ok([200, 201, 204].includes(other.status))
      }
    },
    {
      id: 'plaintext.unique-declare-conflict-409',
      name: '[root] promoting an attribute to unique over Resources that already collide is id-conflict (409)',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const {
          alice,
          createCollection,
          putCollection,
          readCollection,
          resourceUrl
        } = state
        await createCollection({
          id: 'late-unique',
          plaintext: { indexes: ['slug'] }
        })
        for (const resourceId of ['first', 'second']) {
          await alice.rootClient.request({
            url: resourceUrl('late-unique', resourceId),
            method: 'PUT',
            action: 'PUT',
            json: { id: resourceId, slug: 'same' }
          })
        }
        const err = await rejection(
          putCollection('late-unique', {
            id: 'late-unique',
            plaintext: { indexes: [{ name: 'slug', unique: true }] }
          }),
          'expected the unique promotion over colliding Resources to be rejected'
        )
        assert.equal(err.response.status, 409)
        assert.equal(err.data.type, 'https://w3id.org/pws#id-conflict')
        // The stored declaration is unchanged.
        const read = await readCollection('late-unique')
        assert.deepStrictEqual(read.data.plaintext, { indexes: ['slug'] })
      }
    }
  ]
}
