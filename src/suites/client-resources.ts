/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- high-level PwsClient: Resources (JSON + binary).
 *
 * Drives the published `@interop/pws-client` against a live server, covering the
 * client's JSON-vs-binary handling and the null-on-404 read semantics end to
 * end.
 */
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

import type { Collection, Space } from '@interop/pws-client'

interface State {
  alice: any
  space: Space
  jsonCollection: Collection
  binaryCollection: Collection
}

export const clientResources: Suite<State> = {
  id: 'client-resources',
  name: 'PwsClient -- Resources',

  setup: async ctx => {
    // Shallow-clone the shared actor so per-suite scratch fields do not leak
    // into other suites.
    const alice: any = { ...ctx.actors.alice }
    const space = await ctx.provisionSpace({
      pws: alice.pws,
      name: 'Resources Space'
    })
    const jsonCollection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    const binaryCollection = await space.createCollection({
      id: 'files',
      name: 'Files'
    })
    return { alice, space, jsonCollection, binaryCollection }
  },

  teardown: async (ctx, state) => {
    try {
      await state.space.delete()
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'json.add-server-id-and-get',
      name: 'adds a JSON resource (server-generated id) and gets it back',
      group: 'JSON resources',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { jsonCollection } = state
        const result = await jsonCollection.add({ name: 'Sample', value: 42 })
        assert.ok(result.id)
        assert.ok(result.url.includes(`/${result.id}`))
        assert.match(result.contentType!, /json/)

        const fetched = (await jsonCollection.get(result.id)) as any
        assert.equal(fetched.name, 'Sample')
        assert.equal(fetched.value, 42)
      }
    },
    {
      id: 'json.put-upsert-and-list',
      name: 'puts a JSON resource by id (upsert) and lists items',
      group: 'JSON resources',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#list-collection-operation'
      ],
      run: async (ctx, state) => {
        const { jsonCollection } = state
        await jsonCollection.put('greeting', { message: 'hello' })
        assert.equal(
          ((await jsonCollection.get('greeting')) as any).message,
          'hello'
        )

        await jsonCollection.put('greeting', { message: 'updated' })
        assert.equal(
          ((await jsonCollection.get('greeting')) as any).message,
          'updated'
        )

        const listing = await jsonCollection.list()
        assert.ok(listing)
        assert.ok(listing.items.some(item => item.id === 'greeting'))
      }
    },
    {
      id: 'json.get-missing-null',
      name: 'returns null getting a missing resource (404 conflation)',
      group: 'JSON resources',
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async (ctx, state) => {
        const { jsonCollection } = state
        assert.equal(await jsonCollection.get('no-such-resource'), null)
      }
    },
    {
      id: 'json.delete-via-handle',
      name: 'deletes a resource via its handle',
      group: 'JSON resources',
      specRefs: ['https://w3id.org/pws#delete-resource-operation'],
      run: async (ctx, state) => {
        const { jsonCollection } = state
        await jsonCollection.put('temp', { tmp: true })
        assert.notEqual(await jsonCollection.get('temp'), null)
        await jsonCollection.resource('temp').delete()
        assert.equal(await jsonCollection.get('temp'), null)
      }
    },
    {
      id: 'binary.put-read-bytes-text',
      name: 'puts and reads Uint8Array bytes via getBytes/getText',
      group: 'binary resources',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        const bytes = new TextEncoder().encode('line 1\nline 2\n')
        await binaryCollection.put('note.txt', bytes, {
          contentType: 'text/plain'
        })

        const handle = binaryCollection.resource('note.txt')
        assert.equal(await handle.getText(), 'line 1\nline 2\n')
        assert.deepStrictEqual(await handle.getBytes(), bytes)
      }
    },
    {
      id: 'binary.add-returns-blob',
      name: 'add() returns a Blob from get() for non-JSON content',
      group: 'binary resources',
      specRefs: [
        'https://w3id.org/pws#create-resource-add-resource-to-collection-operation',
        'https://w3id.org/pws#read-resource-operation'
      ],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        const blob = new Blob(['hello blob'], { type: 'text/plain' })
        const result = await binaryCollection.add(blob)
        const fetched = await binaryCollection.get(result.id)
        assert.ok(fetched instanceof Blob)
        assert.equal(await fetched.text(), 'hello blob')
      }
    },
    {
      id: 'binary.get-missing-null',
      name: 'getText/getBytes return null for a missing resource',
      group: 'binary resources',
      specRefs: ['https://w3id.org/pws#read-resource-operation'],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        const handle = binaryCollection.resource('absent')
        assert.equal(await handle.getText(), null)
        assert.equal(await handle.getBytes(), null)
      }
    },
    {
      id: 'binary.put-octet-stream-raw',
      name: 'puts raw application/octet-stream bytes (non-multipart) and reads them back',
      group: 'binary resources',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-resource-operation',
        'https://w3id.org/pws#content-types-and-representations'
      ],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
        await binaryCollection.put('raw.bin', bytes, {
          contentType: 'application/octet-stream'
        })

        const handle = binaryCollection.resource('raw.bin')
        assert.deepStrictEqual(await handle.getBytes(), bytes)
        const meta = await handle.meta()
        assert.equal(meta!.contentType, 'application/octet-stream')
        assert.equal(meta!.size, bytes.length)
      }
    },
    {
      id: 'binary.dotted-id-content-type',
      name: 'preserves a dotted resource id and its content-type in listings',
      group: 'binary resources',
      specRefs: [
        'https://w3id.org/pws#content-types-and-representations',
        'https://w3id.org/pws#list-collection-operation'
      ],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        await binaryCollection.put('photo.png', bytes, {
          contentType: 'image/png'
        })

        assert.deepStrictEqual(
          await binaryCollection.resource('photo.png').getBytes(),
          bytes
        )
        assert.equal(
          (await binaryCollection.resource('photo.png').meta())!.contentType,
          'image/png'
        )

        const listing = await binaryCollection.list()
        const entry = listing!.items.find(item => item.id === 'photo.png')
        assert.ok(entry, 'dotted id should appear in the listing')
        assert.equal(entry.contentType, 'image/png')
      }
    },
    {
      id: 'binary.jsonl-raw-not-parsed',
      name: 'stores application/jsonl as raw bytes, not parsed as JSON',
      group: 'binary resources',
      specRefs: ['https://w3id.org/pws#content-types-and-representations'],
      run: async (ctx, state) => {
        const { binaryCollection } = state
        // A JSON-Lines body is several JSON values, not one. The full stack must
        // keep it raw end to end: the server must not route it through the JSON
        // storage path, and the client (down through `@interop/http-client`) must
        // not auto-parse a content-type that merely contains the substring "json"
        // (`response.json()` throws on a JSON-Lines body).
        const body = '{"a":1}\n{"a":2}\n'
        await binaryCollection.put(
          'data.jsonl',
          new Blob([body], { type: 'application/jsonl' })
        )

        const handle = binaryCollection.resource('data.jsonl')
        assert.equal(await handle.getText(), body)
        const meta = await handle.meta()
        assert.equal(meta!.contentType, 'application/jsonl')
        assert.equal(meta!.size, new TextEncoder().encode(body).length)

        // get() returns a Blob (not a parsed object) for the json-substring type.
        const fetched = await binaryCollection.get('data.jsonl')
        assert.ok(fetched instanceof Blob)
        assert.equal(await fetched.text(), body)
      }
    }
  ]
}
