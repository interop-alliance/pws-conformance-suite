/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level WasClient: BYOS backend registration.
 *
 * Drives the published `@interop/was-client` backend-registration control plane
 * (`space.registerBackend` / `updateBackend` / `deregisterBackend`, and
 * selecting a registered backend on a Collection) against a live server, the
 * write side of the spec's "Backends" section. The reference server registers no
 * provider adapters, so a registered `external` backend is selectable but its
 * data plane is inert -- the suite asserts that "registered but not operable"
 * contract too.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

import { ConflictError, ValidationError } from '@interop/was-client'
import type { Space, BackendRegistration } from '@interop/was-client'

interface State {
  alice: any
  createdSpaces: Space[]
  newSpace: (name: string) => Promise<Space>
  gdriveRegistration: (id: string) => BackendRegistration
}

export const clientBackends: Suite<State> = {
  id: 'client-backends',
  name: 'WasClient — BYOS backend registration',

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

    // A representative registration body. `connection` is deliberately
    // secret-bearing (an OAuth authorization code) so the suite can assert the
    // server never echoes it back on the sanitized read.
    const gdriveRegistration = (id: string): BackendRegistration => {
      return {
        id,
        name: 'My Google Drive',
        provider: 'google-drive',
        connection: {
          kind: 'oauth2-google',
          authorizationCode: 'secret-auth-code',
          scope: 'https://www.googleapis.com/auth/drive.file',
          rootFolderName: 'WAS'
        }
      }
    }

    return { alice, createdSpaces, newSpace, gdriveRegistration }
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
      id: 'backend.register-sanitized',
      name: 'registers a backend and returns a sanitized (secret-free) descriptor',
      specRefs: [
        'https://w3id.org/pws#backends',
        'https://w3id.org/pws#backend-data-model'
      ],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Register Backend')
        const descriptor = await space.registerBackend(
          gdriveRegistration('gdrive-personal')
        )
        assert.equal(descriptor.id, 'gdrive-personal')
        assert.equal(descriptor.name, 'My Google Drive')
        assert.equal(descriptor.managedBy, 'external')
        assert.equal(descriptor.provider, 'google-drive')
        // The connection is sanitized: public fields surface (and `status` starts at
        // `registered`, since no provider adapter has connected it yet).
        const connection = descriptor.connection
        assert.ok(connection)
        assert.equal(connection.kind, 'oauth2-google')
        assert.equal(connection.status, 'registered')
        assert.equal(
          connection.scope,
          'https://www.googleapis.com/auth/drive.file'
        )
        assert.equal(connection.rootFolderName, 'WAS')
        assert.match(connection.connectedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
        // The secret-bearing authorization code must never be echoed back anywhere.
        assert.ok(
          !JSON.stringify(descriptor).includes('secret-auth-code'),
          'the sanitized descriptor must not leak the authorization code'
        )
      }
    },
    {
      id: 'backend.list-with-default',
      name: 'lists the registered backend alongside the server default',
      specRefs: ['https://w3id.org/pws#space-backends-available'],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('List Backends')
        await space.registerBackend(gdriveRegistration('gdrive-personal'))
        const backends = await space.backends()
        assert.ok(backends)
        // A server lists its own backends ahead of the registered ones: the
        // `default` entry, then any under their own ids. How many it runs is
        // server-specific.
        assert.ok(backends.some(backend => backend.id === 'default'))
        const external = backends.filter(
          backend => backend.managedBy === 'external'
        )
        assert.equal(external.length, 1)
        const gdrive = external[0]!
        assert.equal(gdrive.id, 'gdrive-personal')
        assert.equal(gdrive.provider, 'google-drive')
        assert.equal(gdrive.connection?.status, 'registered')
        // No secret leaks on the list path either.
        assert.ok(!JSON.stringify(gdrive).includes('secret-auth-code'))
      }
    },
    {
      id: 'backend.duplicate-id-conflict',
      name: 'rejects a duplicate backend id with ConflictError',
      specRefs: [
        'https://w3id.org/pws#backends',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Duplicate Backend')
        await space.registerBackend(gdriveRegistration('gdrive-personal'))
        await assert.rejects(
          space.registerBackend(gdriveRegistration('gdrive-personal')),
          (err: unknown) => err instanceof ConflictError
        )
      }
    },
    {
      id: 'backend.reserved-default-id-validation',
      name: 'rejects registering the reserved "default" id with ValidationError',
      specRefs: [
        'https://w3id.org/pws#backends',
        'https://w3id.org/pws#backend-data-model'
      ],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Reserved Backend Id')
        await assert.rejects(
          space.registerBackend(gdriveRegistration('default')),
          (err: unknown) => err instanceof ValidationError
        )
      }
    },
    {
      id: 'backend.update-create-then-replace',
      name: 'updateBackend creates a record (descriptor) then replaces it in place (null)',
      specRefs: [
        'https://w3id.org/pws#backends',
        'https://w3id.org/pws#backend-data-model'
      ],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Update Backend')
        // PUT to a fresh id creates the record -> 201 + sanitized descriptor.
        const created = await space.updateBackend(
          gdriveRegistration('gdrive-personal')
        )
        assert.ok(created)
        assert.equal(created.id, 'gdrive-personal')
        assert.equal(created.connection?.status, 'registered')
        // PUT to the same id replaces it in place -> 204, no body -> null.
        const replaced = await space.updateBackend({
          id: 'gdrive-personal',
          provider: 'google-drive',
          connection: { kind: 'oauth2-google', authorizationCode: 'fresh-code' }
        })
        assert.equal(replaced, null)
      }
    },
    {
      id: 'backend.select-on-collection',
      name: 'selects a registered backend on a Collection (control plane)',
      specRefs: ['https://w3id.org/pws#collection-backend-selected'],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Select Backend')
        await space.registerBackend(gdriveRegistration('gdrive-personal'))
        const collection = await space.createCollection({
          id: 'on-gdrive',
          backend: { id: 'gdrive-personal' }
        })
        const description = await collection.describe()
        assert.deepStrictEqual(description?.backend, { id: 'gdrive-personal' })
        // "Collection Backend Selected" resolves to the registered descriptor.
        const backend = await collection.backend()
        assert.equal(backend?.id, 'gdrive-personal')
        assert.equal(backend?.provider, 'google-drive')
      }
    },
    {
      id: 'backend.inert-data-plane',
      name: 'a registered backend with no provider adapter is inert (data plane fails closed)',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#backends',
        'https://w3id.org/pws#unsupported-backend'
      ],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Inert Backend')
        await space.registerBackend(gdriveRegistration('gdrive-personal'))
        const collection = await space.createCollection({
          id: 'on-gdrive',
          backend: { id: 'gdrive-personal' }
        })
        // The reference server registers no provider adapters, so writing a resource
        // to the selected backend fails closed with `unsupported-backend` (409).
        await assert.rejects(
          collection.add({ hello: 'world' }),
          (err: unknown) =>
            err instanceof ConflictError &&
            (err.type ?? '').includes('unsupported-backend')
        )
      }
    },
    {
      id: 'backend.deregister-idempotent',
      name: 'deregisters a backend and is idempotent',
      specRefs: ['https://w3id.org/pws#backends'],
      run: async (ctx, state) => {
        const { newSpace, gdriveRegistration } = state
        const space = await newSpace('Deregister Backend')
        await space.registerBackend(gdriveRegistration('gdrive-personal'))
        await space.deregisterBackend('gdrive-personal')
        const backends = await space.backends()
        assert.ok(backends)
        assert.ok(!backends.some(backend => backend.id === 'gdrive-personal'))
        // Deregistering again must not throw (idempotent).
        await space.deregisterBackend('gdrive-personal')
      }
    }
  ]
}
