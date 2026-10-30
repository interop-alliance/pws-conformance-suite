/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Collection client-side encryption descriptor.
 */
import assert from '../harness/assert.js'
import { assertResourceWriteResponse, assertWriteStamp } from '../helpers.js'
import type { Suite } from '../harness/types.js'

import { Collection } from '@interop/pws-client'

/**
 * A minimal conforming EDV Encrypted Document: the stored representation for an
 * `edv` Collection (a JSON object whose `jwe` member is a JWE-JSON envelope),
 * reused for both a content write and a `/meta` `custom` envelope.
 */
const edvDocument = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

/**
 * A descriptor recipient entry (the JWE recipients-entry shape an epoch and
 * the blinding-key `hmac` member share).
 */
function recipient(kid: string): object {
  return {
    header: { kid, alg: 'ECDH-ES+A256KW' },
    encrypted_key: `wrapped-${kid}`
  }
}

/**
 * A valid `edv` descriptor carrying a blinding-key `hmac` member.
 */
function hmacDescriptor(): any {
  return {
    scheme: 'edv',
    hmac: {
      id: 'urn:uuid:blinding-key-1',
      type: 'Sha256HmacKey2019',
      recipients: [recipient('did:key:zApp1#ka')]
    }
  }
}

interface State {
  alice: any
  bob: any
  createCollection: (json: object) => Promise<any>
}

export const encryptionDescriptorApi: Suite<State> = {
  id: 'encryption-descriptor-api',
  name: 'Encryption descriptor API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Encryption Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    /** POSTs a Collection (raw, so an `encryption` descriptor can be sent). */
    function createCollection(json: object): Promise<any> {
      return alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json
      })
    }

    return { alice, bob, createCollection }
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
      id: 'encryption.persist-echo-descriptor',
      name: '[root] persists and echoes the descriptor on create',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const response = await createCollection({
          id: 'vault',
          name: 'Vault',
          encryption: { scheme: 'edv' }
        })
        assert.equal(response.status, 201)
        assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })

        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.delegated-discovers-descriptor',
      name: 'a delegated consumer discovers the descriptor by reading the Metadata object',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { alice, bob } = state
        // Alice grants Bob read on the vault; Bob -- who did not create it --
        // rebuilds a handle and reads the Metadata object, seeing the
        // descriptor (this is how a consuming app learns to decrypt with its
        // own keys).
        const zcap = await alice.pws
          .space(alice.space1.id)
          .collection('vault')
          .grant({ to: bob.did, actions: ['GET'] })

        const handle = bob.pws.fromCapability(zcap)
        assert.ok(handle instanceof Collection)
        const metadata = (await handle.describe()) as any
        assert.deepStrictEqual(metadata.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.malformed-descriptor-400',
      name: '[root] rejects a malformed descriptor (400 invalid-request-body)',
      specRefs: ['https://w3id.org/pws#invalid-request-body'],
      run: async (ctx, state) => {
        const { createCollection } = state
        let expectedError: any
        try {
          await createCollection({ id: 'bad', encryption: { foo: 1 } })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the malformed-descriptor create to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'encryption.unrecognized-scheme-400',
      name: '[root] rejects an unrecognized scheme on first declaration (400 unsupported-encryption-scheme)',
      specRefs: ['https://w3id.org/pws#unsupported-encryption-scheme'],
      run: async (ctx, state) => {
        const { createCollection } = state
        // The fail-closed scheme gate (spec "Encryption Scheme Registry"): a
        // first declaration naming a scheme the server does not recognize is
        // rejected rather than stored opaquely. A fresh Collection keeps this
        // unambiguous -- on an already-marked one the set-once
        // `encryption-immutable` check may fire instead (see the
        // descriptor-immutability tests below).
        let expectedError: any
        try {
          await createCollection({
            id: 'bad-scheme',
            encryption: { scheme: 'other' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the unrecognized scheme to be rejected'
        )
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#unsupported-encryption-scheme'
        )
      }
    },
    {
      id: 'encryption.change-scheme-immutable',
      name: '[root] rejects changing the scheme of an existing descriptor and preserves it',
      specRefs: [
        'https://w3id.org/pws#encryption-immutable',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The descriptor is set-once: changing an existing descriptor's scheme MUST be
        // rejected with `encryption-immutable` (409). A generic suite cannot
        // name a second scheme the server recognizes, so a server whose
        // fail-closed registry gate runs first may instead report the probe
        // scheme as 400 `unsupported-encryption-scheme` -- both rejections are
        // accepted; either way the stored descriptor must survive intact.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'vault', encryption: { scheme: 'other' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the scheme change to be rejected')
        const { status } = expectedError.response
        assert.ok(
          status === 409 || status === 400,
          `expected 409 or 400 for the scheme change, got ${status}`
        )
        assert.equal(
          expectedError.data.type,
          status === 409
            ? 'https://w3id.org/pws#encryption-immutable'
            : 'https://w3id.org/pws#unsupported-encryption-scheme'
        )

        // The stored descriptor must be unchanged.
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.clear-descriptor-immutable',
      name: '[root] an update cannot clear an existing descriptor',
      specRefs: [
        'https://w3id.org/pws#encryption-immutable',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Clearing is forbidden on the same set-once terms as changing. `PUT`
        // is a full replacement, so a body sent without `encryption` would
        // otherwise clear it -- the server MUST refuse that as an attempt to
        // clear the descriptor (`encryption-immutable`, 409); unlike `backend`
        // or `plaintext`, `encryption` has no "omitted means untouched"
        // carve-out.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'vault', name: 'Vault' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the descriptor-clearing update to be rejected'
        )
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-immutable'
        )

        // The stored descriptor must survive.
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
      }
    },
    {
      id: 'encryption.non-envelope-write-422',
      name: '[root] rejects a non-envelope write into an encrypted Collection (422 scheme-mismatch)',
      specRefs: ['https://w3id.org/pws#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The fail-closed guarantee (spec "Encryption Scheme Registry"): the `vault`
        // Collection is `edv`, so a plaintext JSON write is structurally rejected --
        // server-visible plaintext can never land in an encrypted Collection, even
        // from a writer that forgets (or refuses) to encrypt.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/plaintext-doc`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { hello: 'world' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the plaintext write to be rejected')
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.wrong-content-type-write-422',
      name:
        '[root] rejects a valid envelope written under the wrong Content-Type ' +
        '(422 scheme-mismatch)',
      specRefs: ['https://w3id.org/pws#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The `edv` scheme's registered media type is `application/json`. A
        // write whose body IS a structurally valid envelope but whose
        // Content-Type is something else (here `text/plain`) fails the
        // media-type gate and MUST be rejected with `encryption-scheme-mismatch`
        // -- so no representation can slip past the fail-closed guarantee by
        // mislabelling its content type.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/mislabelled-doc`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            body: new TextEncoder().encode(JSON.stringify(edvDocument)),
            headers: { 'content-type': 'text/plain' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the wrong-Content-Type envelope write to be rejected'
        )
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.accepts-edv-document',
      name: '[root] accepts a conforming EDV Document into an encrypted Collection',
      specRefs: ['https://w3id.org/pws#encryption-scheme-registry'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The stored representation is an EDV Encrypted Document (`{ jwe, ... }`)
        // under `application/json` -- what the EDV codec actually produces.
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          body: new TextEncoder().encode(JSON.stringify(edvDocument)),
          headers: { 'content-type': 'application/json' }
        })
        assertResourceWriteResponse({ response, created: true })
      }
    },
    {
      id: 'encryption.plaintext-meta-422',
      name: '[root] rejects a plaintext `custom` on PUT /meta of an encrypted Collection (422)',
      specRefs: ['https://w3id.org/pws#encryption-scheme-mismatch'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Spec "Encrypted Collections": on an encrypted Collection a resource's
        // user-writable `custom` metadata MUST be a conforming envelope, so a
        // plaintext `{ name }` is fail-closed rejected -- server-visible plaintext
        // name/tags can never land in an encrypted Collection.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/vault/envelope-doc/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { custom: { name: 'leaked' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected the plaintext /meta write to be rejected'
        )
        assert.equal(expectedError.response.status, 422)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-scheme-mismatch'
        )
      }
    },
    {
      id: 'encryption.envelope-meta-etag',
      name: '[root] accepts an envelope `custom` on PUT /meta and returns its /meta ETag',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#update-resource-metadata-operation',
        'https://w3id.org/pws#resource-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          json: { custom: edvDocument }
        })
        assertResourceWriteResponse({
          response,
          created: false,
          metaWrite: true
        })
        // The `/meta` sub-resource carries its own ETag.
        assert.ok(response.headers.get('etag'), 'expected a /meta ETag')

        // GET /meta returns the opaque envelope verbatim (no plaintext name leaked).
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/envelope-doc/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.custom, edvDocument)
      }
    },
    {
      id: 'encryption.replicates-metadata-changes',
      name: '[root] replicates the encrypted metadata edit in the changes feed',
      optional: true,
      specRefs: ['https://w3id.org/pws#query-profile-changes'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Decision 6: a metadata-only edit rides the change feed. The resource
        // re-surfaces carrying the opaque `custom` envelope and its metadata
        // stamp (`meta`), so a replicating client picks up the metadata
        // change without decryption.
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/vault/query`,
            serverUrl
          ).toString(),
          method: 'POST',
          action: 'POST',
          json: { profile: 'changes', limit: 100 }
        })
        assert.equal(response.status, 200)
        const doc = response.data.documents.find(
          (entry: any) =>
            entry.kind === 'resource' && entry.id === 'envelope-doc'
        )
        assert.ok(doc, 'expected the edited resource in the feed')
        assert.deepStrictEqual(doc.custom, edvDocument)
        assert.ok(doc.meta && typeof doc.meta === 'object')
        assertWriteStamp(doc.meta)
        assert.equal(typeof doc.meta.generation, 'string')
      }
    },
    {
      id: 'encryption.version-persist-echo',
      name: '[root] persists and echoes a descriptor with an integer version',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#encryption-scheme-registry'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        // The `version` member is an optional positive integer naming the
        // scheme's registered wire-format revision; `edv` version `1` is the
        // registry's baseline every conformant server recognizes.
        const response = await createCollection({
          id: 'versioned-vault',
          encryption: { scheme: 'edv', version: 1 }
        })
        assert.equal(response.status, 201)

        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/versioned-vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(read.data.encryption.scheme, 'edv')
        assert.equal(read.data.encryption.version, 1)
      }
    },
    {
      id: 'encryption.version-invalid-400',
      name: '[root] rejects a non-integer version (400 invalid-request-body)',
      specRefs: ['https://w3id.org/pws#invalid-request-body'],
      run: async (ctx, state) => {
        const { createCollection } = state
        // The data model: `version` is a positive integer, not a semantic
        // version -- the pre-integer string form (e.g. "0.1") is malformed.
        let expectedError: any
        try {
          await createCollection({
            id: 'bad-version',
            encryption: { scheme: 'edv', version: '0.1' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the string version to be rejected')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#invalid-request-body'
        )
      }
    },
    {
      id: 'encryption.version-explicit-1-noop',
      name: '[root] accepts an explicit version 1 on a descriptor that had omitted it',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        // An absent `version` means `1`, so re-declaring the standing values
        // with an explicit `version: 1` is an idempotent no-op that MUST be
        // accepted. The read-back may keep it explicit or absent -- the two
        // spellings are the same value.
        const created = await createCollection({
          id: 'versionless',
          encryption: { scheme: 'edv' }
        })
        assert.equal(created.status, 201)
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/versionless/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'versionless', encryption: { scheme: 'edv', version: 1 } }
        })
        assert.ok(
          response.status >= 200 && response.status < 300,
          `expected the explicit version 1 re-declaration to be accepted, got ${response.status}`
        )
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/versionless/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(read.data.encryption.scheme, 'edv')
        const { version } = read.data.encryption
        assert.ok(
          version === 1 || version === undefined,
          `expected version 1 (explicit or absent), got ${version}`
        )
      }
    },
    {
      id: 'encryption.version-remove-immutable',
      name: '[root] an update cannot remove the version once set',
      specRefs: [
        'https://w3id.org/pws#encryption-immutable',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The descriptor is version-monotonic: removing the `version` MUST be
        // rejected with `encryption-immutable` (409). Because an absent
        // `version` means `1`, a server MAY instead read this re-declaration
        // (stored version 1, incoming omitted) as the standing value and accept
        // it as a no-op. What MUST NOT happen is the version changing to
        // anything else.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/versioned-vault/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'versioned-vault', encryption: { scheme: 'edv' } }
          })
        } catch (err) {
          expectedError = err
        }
        if (expectedError) {
          assert.equal(expectedError.response.status, 409)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#encryption-immutable'
          )
        }

        // Either way, the standing version must survive semantically.
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/versioned-vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.equal(read.data.encryption.scheme, 'edv')
        const { version } = read.data.encryption
        assert.ok(
          version === 1 || version === undefined,
          `expected the standing version 1 to survive, got ${version}`
        )
      }
    },
    {
      id: 'encryption.version-raise-not-immutable',
      name: '[root] raising the version is not an immutability conflict',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#encryption-scheme-registry'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Raising the `version` is explicitly permitted (a future scheme
        // migration), subject to the registry recognition rule -- so a raise
        // MUST NOT be rejected as `encryption-immutable`. A server that does
        // not recognize the raised version (the registry defines only `edv` 1
        // today) rejects it as 400 `unsupported-encryption-scheme` instead;
        // one that recognizes or stores it opaquely accepts it.
        let expectedError: any
        let response: any
        try {
          response = await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/versioned-vault/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: {
              id: 'versioned-vault',
              encryption: { scheme: 'edv', version: 2 }
            }
          })
        } catch (err) {
          expectedError = err
        }
        if (expectedError) {
          assert.equal(expectedError.response.status, 400)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#unsupported-encryption-scheme'
          )
          // The rejected raise must leave the stored descriptor unchanged.
          const read = await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/versioned-vault/meta`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
          const { version } = read.data.encryption
          assert.ok(
            version === 1 || version === undefined,
            `expected the stored version 1 to survive, got ${version}`
          )
        } else {
          assert.ok(
            response.status >= 200 && response.status < 300,
            `expected the raise to be accepted or 400, got ${response.status}`
          )
        }
      }
    },
    {
      id: 'encryption.version-unrecognized',
      name: '[root] an unrecognized version is rejected or stored opaquely, never mangled',
      optional: true,
      specRefs: ['https://w3id.org/pws#unsupported-encryption-scheme'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        // The accept-only-what-you-enforce SHOULD applies to versions on the
        // same terms as schemes: a version of a recognized scheme the server
        // does not recognize SHOULD be rejected with
        // `unsupported-encryption-scheme` rather than stored unenforced. A
        // server taking the MAY-store path must round-trip it verbatim.
        let expectedError: any
        let response: any
        try {
          response = await createCollection({
            id: 'future-version',
            encryption: { scheme: 'edv', version: 99 }
          })
        } catch (err) {
          expectedError = err
        }
        if (expectedError) {
          assert.equal(expectedError.response.status, 400)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#unsupported-encryption-scheme'
          )
        } else {
          assert.equal(response.status, 201)
          const read = await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/future-version/meta`,
              serverUrl
            ).toString(),
            method: 'GET'
          })
          assert.equal(read.data.encryption.version, 99)
        }
      }
    },
    {
      id: 'encryption.hmac-persist-echo',
      name: '[root] persists and echoes the blinding-key hmac member verbatim',
      specRefs: [
        'https://w3id.org/pws#blinding-key-member',
        'https://w3id.org/pws#collection-metadata-data-model'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const response = await createCollection({
          id: 'hmac-vault',
          encryption: hmacDescriptor()
        })
        assert.equal(response.status, 201)
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-vault/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, hmacDescriptor())
      }
    },
    {
      id: 'encryption.hmac-malformed-400',
      name: '[root] rejects a malformed hmac member (400 invalid-request-body)',
      specRefs: [
        'https://w3id.org/pws#key-epoch-server-validation',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createCollection } = state
        // Each case violates one rule of the hmac shape: a non-empty string
        // `id` and `type`, a non-empty `recipients` array, and the epoch
        // recipients-entry shape for every entry.
        const cases: [string, object][] = [
          [
            'missing-id',
            { type: 'Sha256HmacKey2019', recipients: [recipient('k')] }
          ],
          ['missing-type', { id: 'urn:k', recipients: [recipient('k')] }],
          [
            'empty-recipients',
            { id: 'urn:k', type: 'Sha256HmacKey2019', recipients: [] }
          ],
          [
            'bad-recipient',
            { id: 'urn:k', type: 'Sha256HmacKey2019', recipients: [{ foo: 1 }] }
          ]
        ]
        for (const [label, hmac] of cases) {
          let expectedError: any
          try {
            await createCollection({
              id: `hmac-${label}`,
              encryption: { scheme: 'edv', hmac }
            })
          } catch (err) {
            expectedError = err
          }
          assert.ok(expectedError, `expected hmac with ${label} to be rejected`)
          assert.equal(expectedError.response.status, 400, label)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#invalid-request-body',
            label
          )
        }
      }
    },
    {
      id: 'encryption.hmac-id-change-immutable',
      name: '[root] an update cannot change the hmac id (409 encryption-immutable)',
      specRefs: [
        'https://w3id.org/pws#key-epoch-server-validation',
        'https://w3id.org/pws#encryption-immutable'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const created = await createCollection({
          id: 'hmac-id-locked',
          encryption: hmacDescriptor()
        })
        assert.equal(created.status, 201)
        const changed = hmacDescriptor()
        changed.hmac.id = 'urn:uuid:blinding-key-2'
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/hmac-id-locked/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'hmac-id-locked', encryption: changed }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the hmac id change to be rejected')
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-immutable'
        )
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-id-locked/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, hmacDescriptor())
      }
    },
    {
      id: 'encryption.hmac-remove-immutable',
      name: '[root] an update cannot remove the hmac member (409 encryption-immutable)',
      specRefs: [
        'https://w3id.org/pws#key-epoch-server-validation',
        'https://w3id.org/pws#encryption-immutable'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const created = await createCollection({
          id: 'hmac-remove-locked',
          encryption: hmacDescriptor()
        })
        assert.equal(created.status, 201)
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: new URL(
              `/space/${alice.space1.id}/hmac-remove-locked/meta`,
              serverUrl
            ).toString(),
            method: 'PUT',
            action: 'PUT',
            json: { id: 'hmac-remove-locked', encryption: { scheme: 'edv' } }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the hmac removal to be rejected')
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-immutable'
        )
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-remove-locked/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, hmacDescriptor())
      }
    },
    {
      id: 'encryption.hmac-recipients-change-accepted',
      name: '[root] an update may change the hmac recipients',
      specRefs: [
        'https://w3id.org/pws#key-epoch-server-validation',
        'https://w3id.org/pws#blinding-key-member'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        const created = await createCollection({
          id: 'hmac-rewrap',
          encryption: hmacDescriptor()
        })
        assert.equal(created.status, 201)
        // Adding a reader wraps the blinding key to it; the key itself (its
        // `id` and `type`) is unchanged.
        const rewrapped = hmacDescriptor()
        rewrapped.hmac.recipients = [
          recipient('did:key:zApp1#ka'),
          recipient('did:key:zApp3#ka')
        ]
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-rewrap/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'hmac-rewrap', encryption: rewrapped }
        })
        assert.ok(
          response.status >= 200 && response.status < 300,
          `expected the recipients change to be accepted, got ${response.status}`
        )
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-rewrap/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, rewrapped)
      }
    },
    {
      id: 'encryption.hmac-late-introduction-accepted',
      name: '[root] an update may introduce hmac on a descriptor that lacks it',
      specRefs: [
        'https://w3id.org/pws#key-epoch-server-validation',
        'https://w3id.org/pws#blinding-key-member'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, createCollection } = state
        // Whether a client may install the key after provisioning is a
        // client-profile rule; the server treats late introduction as a first
        // declaration and accepts it.
        const created = await createCollection({
          id: 'hmac-late',
          encryption: { scheme: 'edv' }
        })
        assert.equal(created.status, 201)
        const response = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-late/meta`,
            serverUrl
          ).toString(),
          method: 'PUT',
          action: 'PUT',
          json: { id: 'hmac-late', encryption: hmacDescriptor() }
        })
        assert.ok(
          response.status >= 200 && response.status < 300,
          `expected the late hmac introduction to be accepted, got ${response.status}`
        )
        const read = await alice.rootClient.request({
          url: new URL(
            `/space/${alice.space1.id}/hmac-late/meta`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
        assert.deepStrictEqual(read.data.encryption, hmacDescriptor())
      }
    }
  ]
}
