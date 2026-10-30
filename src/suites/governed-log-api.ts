/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- a Collection's governing history log (the
 * `governed-history-logs` feature).
 *
 * The log is the sub-resource `/space/{space}/{collection}/meta/log`: a JSON
 * Lines body whose last line is the head entry, and whose head `state` the
 * server serves as the Collection's `encryption` descriptor with a
 * `history: { method, resource }` member stamped on. A Collection becomes
 * governed by the guarded create of its log (`PUT` with `If-None-Match: *`);
 * later writes are compare-and-swap appends (`If-Match` carrying the prior
 * bytes plus one new line), 412 on a lost race. The server verifies neither
 * entry proofs nor the hash chain; it checks the line contract and runs the
 * encryption descriptor's transition checks between the prior head and the
 * new one.
 *
 * The sub-resource is OPTIONAL, advertised by the `governed-history-logs` token
 * of the Encrypted Collections entry in the service description. Rather than
 * mark the whole suite optional, setup() reads that document and each test
 * skips when the token is absent; once advertised, the behaviors below are
 * MUST-level and run at the required tier.
 *
 * The log is written and read through raw `fetch` over the low-level signing
 * primitive: the body is `text/jsonl` (not JSON, which the high-level clients
 * would parse), and a 304 or a problem response is read like any other.
 */
import { spaceUrlById } from '@interop/pws-client/paths'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type { ISigner } from '@interop/data-integrity-core'
import assert from '../harness/assert.js'
import {
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  serviceFeatures
} from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  governedSupported: boolean
  /** Absolute URL of a Collection (no trailing slash). */
  collectionUrl: (collectionId: string) => string
  /** Absolute URL of a Collection's governing log sub-resource. */
  logUrl: (collectionId: string) => string
  /** Creates a fresh Collection (plaintext by default) and returns its id. */
  freshCollection: (body?: object) => Promise<string>
  /** Governs a fresh Collection with a one-epoch genesis line. */
  governedCollection: () => Promise<{
    collectionId: string
    body: string
    etag: string
  }>
  /** Signs and sends a log write as Alice under the given preconditions. */
  putLog: (options: {
    collectionId: string
    body: string
    headers?: Record<string, string>
  }) => Promise<Response>
  /** Signs and sends a log read, optionally as another caller. */
  getLog: (options: {
    collectionId: string
    headers?: Record<string, string>
    invocationSigner?: ISigner
    capability?: any
  }) => Promise<Response>
}

/**
 * A minimal conforming EDV Encrypted Document envelope, the stored
 * representation an `edv` (encrypted) Collection requires for a Resource.
 */
const edvDocument = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

/**
 * A descriptor recipient entry (the JWE recipients-entry shape).
 *
 * @param kid {string}
 * @returns {object}
 */
function recipient(kid: string): object {
  return {
    header: { kid, alg: 'ECDH-ES+A256KW' },
    encrypted_key: `wrapped-${kid}`
  }
}

/** A one-epoch `edv` key-epoch descriptor, the genesis head state. */
const oneEpoch = {
  type: 'WasEpochConfiguration',
  scheme: 'edv',
  currentEpoch: 'urn:epoch:1',
  epochs: [{ id: 'urn:epoch:1', recipients: [recipient('did:key:zApp1#ka')] }]
}

/** The same descriptor after one rotation: a second, newer epoch. */
const twoEpochs = {
  ...oneEpoch,
  currentEpoch: 'urn:epoch:2',
  epochs: [
    { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp2#ka')] },
    ...oneEpoch.epochs
  ]
}

/**
 * One log entry line: the resource-log entry members with `state` as given.
 * The server reads only `state` (and the genesis `parameters.method`); the
 * rest is the profile's business and is not verified here.
 *
 * @param options {object}
 * @param options.ordinal {number}
 * @param options.state {object}
 * @param [options.parameters] {object}
 * @returns {string}
 */
function entryLine({
  ordinal,
  state,
  parameters = {}
}: {
  ordinal: number
  state: object
  parameters?: object
}): string {
  return JSON.stringify({
    versionId: `${ordinal}-hash${ordinal}`,
    versionTime: '2026-09-07T00:00:00Z',
    parameters,
    state,
    proof: []
  })
}

/**
 * The genesis line, carrying the format identifier and the SCID.
 *
 * @param state {object}
 * @returns {string}
 */
function genesisLine(state: object): string {
  return entryLine({
    ordinal: 1,
    state,
    parameters: { method: 'resource-log:0.1', scid: 'zScid' }
  })
}

/**
 * Asserts a response is a problem document of the given status whose `type`
 * ends in the given registry anchor.
 *
 * @param options {object}
 * @param options.response {Response}
 * @param options.status {number}
 * @param options.type {string}   the problem-type anchor, e.g. `not-found`
 * @returns {Promise<any>}   the parsed problem document
 */
async function assertProblem({
  response,
  status,
  type
}: {
  response: Response
  status: number
  type: string
}): Promise<any> {
  assert.equal(response.status, status)
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/problem\+json/
  )
  const problem = await response.json()
  assert.equal(problem.type, `https://w3id.org/pws#${type}`)
  return problem
}

export const governedLogApi: Suite<State> = {
  id: 'governed-log-api',
  name: 'Governing history log API',
  specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],

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
        name: "Alice's Governed Log Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })

    function collectionUrl(collectionId: string): string {
      return new URL(
        `/space/${alice.space1.id}/${collectionId}`,
        ctx.serverUrl
      ).toString()
    }

    function logUrl(collectionId: string): string {
      return `${collectionUrl(collectionId)}/meta/log`
    }

    async function freshCollection(body: object = {}): Promise<string> {
      const collectionId = `col-${ctx.generateId()}`
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json: { id: collectionId, name: collectionId, ...body }
      })
      return collectionId
    }

    async function putLog({
      collectionId,
      body,
      headers = {}
    }: {
      collectionId: string
      body: string
      headers?: Record<string, string>
    }): Promise<Response> {
      const url = logUrl(collectionId)
      const bytes = new TextEncoder().encode(body)
      const signatureHeaders = await signCapabilityInvocation({
        url,
        method: 'PUT',
        headers: {
          date: new Date().toUTCString(),
          'content-type': 'text/jsonl'
        },
        invocationSigner: alice.signer,
        capabilityAction: 'PUT',
        body: bytes
      })
      // The precondition headers describe the request, not the capability
      // target, so they ride outside the signature. The cast is fetch's
      // `BodyInit` typing rejecting a bare `Uint8Array` (a lib variance quirk).
      return fetch(url, {
        method: 'PUT',
        headers: {
          ...(signatureHeaders as Record<string, string>),
          ...headers
        },
        body: bytes as unknown as BodyInit
      })
    }

    async function getLog({
      collectionId,
      headers = {},
      invocationSigner = alice.signer,
      capability
    }: {
      collectionId: string
      headers?: Record<string, string>
      invocationSigner?: ISigner
      capability?: any
    }): Promise<Response> {
      const url = logUrl(collectionId)
      const signatureHeaders = await signCapabilityInvocation({
        url,
        method: 'GET',
        headers: { date: new Date().toUTCString() },
        invocationSigner,
        capabilityAction: 'GET',
        ...(capability !== undefined && { capability })
      })
      return fetch(url, {
        method: 'GET',
        headers: { ...(signatureHeaders as Record<string, string>), ...headers }
      })
    }

    async function governedCollection(): Promise<{
      collectionId: string
      body: string
      etag: string
    }> {
      const collectionId = await freshCollection()
      const body = genesisLine(oneEpoch) + '\n'
      const created = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204, await created.text())
      const etag = created.headers.get('etag')
      assert.ok(etag, 'expected the guarded create to return an ETag')
      return { collectionId, body, etag }
    }

    const features = await serviceFeatures({
      serverUrl: ctx.serverUrl,
      specIdentifier: ENCRYPTED_COLLECTIONS_IDENTIFIER
    })
    const governedSupported = features.includes('governed-history-logs')

    return {
      alice,
      bob,
      governedSupported,
      collectionUrl,
      logUrl,
      freshCollection,
      governedCollection,
      putLog,
      getLog
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
      id: 'governed-log.guarded-create-derives-encryption',
      name: '[root] a guarded create governs the Collection: encryption is the head state plus history',
      run: async (ctx, state) => {
        const { alice, collectionUrl, logUrl, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId } = await governedCollection()
        const expected = {
          ...oneEpoch,
          history: {
            method: 'resource-log:0.1',
            resource: logUrl(collectionId)
          }
        }

        const described = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })
        assert.deepStrictEqual(described.data.encryption, expected)
      }
    },
    {
      id: 'governed-log.read-verbatim-with-etag',
      name: '[root] the log reads back verbatim as text/jsonl with the ETag the create returned',
      run: async (ctx, state) => {
        const { getLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body, etag } = await governedCollection()
        const read = await getLog({ collectionId })
        assert.equal(read.status, 200)
        assert.match(read.headers.get('content-type') ?? '', /^text\/jsonl/)
        assert.equal(read.headers.get('etag'), etag)
        assert.equal(await read.text(), body)
      }
    },
    {
      id: 'governed-log.conditional-read-304',
      name: '[root] a log GET with a matching If-None-Match is 304 with the ETag and no body',
      optional: true,
      specRefs: ['https://w3id.org/pws#caching'],
      run: async (ctx, state) => {
        const { getLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, etag } = await governedCollection()
        const conditional = await getLog({
          collectionId,
          headers: { 'if-none-match': etag }
        })
        assert.equal(conditional.status, 304)
        assert.equal(conditional.headers.get('etag'), etag)
        assert.equal(await conditional.text(), '')
      }
    },
    {
      id: 'governed-log.missing-log-404',
      name: '[root] a Collection with no log is 404 on the log read, and a nonexistent Collection is 404 on the log write',
      run: async (ctx, state) => {
        const { freshCollection, getLog, putLog } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const collectionId = await freshCollection()
        await assertProblem({
          response: await getLog({ collectionId }),
          status: 404,
          type: 'not-found'
        })
        // A log write never creates the Collection it would govern.
        await assertProblem({
          response: await putLog({
            collectionId: `absent-${ctx.generateId()}`,
            body: genesisLine(oneEpoch) + '\n',
            headers: { 'if-none-match': '*' }
          }),
          status: 404,
          type: 'not-found'
        })
      }
    },
    {
      id: 'governed-log.append-compare-and-swap',
      name: '[root] an If-Match append lands, bumps the log ETag, and moves the derived member to the new head',
      run: async (ctx, state) => {
        const { alice, collectionUrl, putLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body, etag } = await governedCollection()
        const before = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })

        const extended =
          body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
        const appended = await putLog({
          collectionId,
          body: extended,
          headers: { 'if-match': etag }
        })
        assert.equal(appended.status, 204, await appended.text())
        const newEtag = appended.headers.get('etag')
        assert.ok(newEtag, 'expected the append to return an ETag')
        assert.notEqual(newEtag, etag)

        const after = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })
        assert.equal(after.data.encryption.currentEpoch, 'urn:epoch:2')
        assert.equal(after.data.encryption.epochs.length, 2)
        // The Metadata object's own ETag moves too: its served content
        // changed.
        assert.notEqual(
          after.headers.get('etag'),
          before.headers.get('etag'),
          'expected a log append to bump the Collection Metadata object ETag'
        )
      }
    },
    {
      id: 'governed-log.stale-if-match-412',
      name: '[root] a stale If-Match append is 412 precondition-failed and the log is unchanged',
      specRefs: ['https://w3id.org/pws#precondition-failed'],
      run: async (ctx, state) => {
        const { getLog, putLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body, etag } = await governedCollection()
        const extended =
          body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
        const won = await putLog({
          collectionId,
          body: extended,
          headers: { 'if-match': etag }
        })
        assert.equal(won.status, 204)
        const winnerEtag = won.headers.get('etag')

        const lost = await putLog({
          collectionId,
          body: extended,
          headers: { 'if-match': etag }
        })
        await assertProblem({
          response: lost,
          status: 412,
          type: 'precondition-failed'
        })
        const read = await getLog({ collectionId })
        assert.equal(read.headers.get('etag'), winnerEtag)
        assert.equal(await read.text(), extended)
      }
    },
    {
      id: 'governed-log.append-fast-forward-only',
      name: '[root] an append must fast-forward the stored log: a rewritten prefix is 412 under a current If-Match, adding several lines is 400, re-sending the stored log is a no-op 204, and the log is unchanged',
      specRefs: [
        'https://w3id.org/pws#precondition-failed',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { getLog, putLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body, etag } = await governedCollection()
        const secondLine = entryLine({ ordinal: 2, state: twoEpochs }) + '\n'

        // A rewritten genesis (different versionId) under the current ETag.
        const rewritten =
          entryLine({
            ordinal: 9,
            state: oneEpoch,
            parameters: { method: 'resource-log:0.1', scid: 'zScid' }
          }) +
          '\n' +
          secondLine
        await assertProblem({
          response: await putLog({
            collectionId,
            body: rewritten,
            headers: { 'if-match': etag }
          }),
          status: 412,
          type: 'precondition-failed'
        })

        // The stored bytes plus two lines.
        await assertProblem({
          response: await putLog({
            collectionId,
            body:
              body +
              secondLine +
              entryLine({ ordinal: 3, state: twoEpochs }) +
              '\n',
            headers: { 'if-match': etag }
          }),
          status: 400,
          type: 'invalid-request-body'
        })

        // The stored bytes alone: a no-op answered 204 with the current ETag.
        const resend = await putLog({
          collectionId,
          body,
          headers: { 'if-match': etag }
        })
        assert.equal(resend.status, 204)
        assert.equal(resend.headers.get('etag'), etag)

        const read = await getLog({ collectionId })
        assert.equal(read.headers.get('etag'), etag)
        assert.equal(await read.text(), body)
      }
    },
    {
      id: 'governed-log.guarded-create-existing-412',
      name: '[root] a guarded create on an existing log is 412 precondition-failed',
      specRefs: ['https://w3id.org/pws#precondition-failed'],
      run: async (ctx, state) => {
        const { putLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body } = await governedCollection()
        await assertProblem({
          response: await putLog({
            collectionId,
            body,
            headers: { 'if-none-match': '*' }
          }),
          status: 412,
          type: 'precondition-failed'
        })
      }
    },
    {
      id: 'governed-log.direct-encryption-write-refused',
      name: '[root] a direct encryption write on a governed Collection is 409 encryption-history-log-governed',
      specRefs: ['https://w3id.org/pws#encryption-history-log-governed'],
      run: async (ctx, state) => {
        const { alice, collectionUrl, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId } = await governedCollection()
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: `${collectionUrl(collectionId)}/meta`,
            method: 'PUT',
            action: 'PUT',
            json: { id: collectionId, encryption: twoEpochs }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the direct write to be refused')
        assert.equal(expectedError.response.status, 409)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#encryption-history-log-governed'
        )

        // The descriptor is untouched, and a Metadata object update that
        // leaves `encryption` alone still lands.
        const described = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })
        assert.equal(described.data.encryption.currentEpoch, 'urn:epoch:1')
        const renamed = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'PUT',
          action: 'PUT',
          json: { id: collectionId, name: 'Renamed' }
        })
        assert.equal(renamed.status, 204)
        const reread = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })
        assert.equal(reread.data.name, 'Renamed')
        assert.equal(reread.data.encryption.currentEpoch, 'urn:epoch:1')
      }
    },
    {
      id: 'governed-log.epoch-violation-refused',
      name: '[root] an append that drops an epoch or moves currentEpoch back is refused and the log is unchanged',
      specRefs: ['https://w3id.org/pws#collection-metadata-data-model'],
      run: async (ctx, state) => {
        const { freshCollection, getLog, putLog } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const collectionId = await freshCollection()
        const body = genesisLine(twoEpochs) + '\n'
        const created = await putLog({
          collectionId,
          body,
          headers: { 'if-none-match': '*' }
        })
        assert.equal(created.status, 204, await created.text())
        const etag = created.headers.get('etag')

        // Rolling back to the one-epoch state both drops an epoch and moves
        // `currentEpoch` to an older one; either alone is enough to refuse.
        const rolledBack =
          body + entryLine({ ordinal: 2, state: oneEpoch }) + '\n'
        const response = await putLog({
          collectionId,
          body: rolledBack,
          headers: { 'if-match': etag! }
        })
        assert.equal(response.status, 400)
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/problem\+json/
        )
        const read = await getLog({ collectionId })
        assert.equal(read.headers.get('etag'), etag)
        assert.equal(await read.text(), body)
      }
    },
    {
      id: 'governed-log.line-contract-break-400',
      name: '[root] a body that breaks the line contract is 400 invalid-request-body and governs nothing',
      specRefs: ['https://w3id.org/pws#invalid-request-body'],
      run: async (ctx, state) => {
        const { freshCollection, getLog, putLog } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const collectionId = await freshCollection()
        const bodies = [
          // Empty: no head entry.
          '',
          // Not JSON.
          'not json\n',
          // An object with no `state` member.
          JSON.stringify({ versionId: '1-x', parameters: {} }) + '\n',
          // A blank line between entries.
          genesisLine(oneEpoch) +
            '\n\n' +
            entryLine({ ordinal: 2, state: oneEpoch })
        ]
        for (const body of bodies) {
          const response = await putLog({
            collectionId,
            body,
            headers: { 'if-none-match': '*' }
          })
          assert.equal(response.status, 400, `body ${JSON.stringify(body)}`)
          const problem = await response.json()
          assert.equal(
            problem.type,
            'https://w3id.org/pws#invalid-request-body'
          )
        }
        // None of them declared the Collection governed.
        assert.equal((await getLog({ collectionId })).status, 404)
      }
    },
    {
      id: 'governed-log.already-described-refused',
      name: '[root] governing a Collection that already carries a client-written descriptor is 409 encryption-immutable',
      specRefs: ['https://w3id.org/pws#encryption-immutable'],
      run: async (ctx, state) => {
        const { freshCollection, getLog, putLog } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const collectionId = await freshCollection({
          encryption: { scheme: 'edv' }
        })
        await assertProblem({
          response: await putLog({
            collectionId,
            body: genesisLine(oneEpoch) + '\n',
            headers: { 'if-none-match': '*' }
          }),
          status: 409,
          type: 'encryption-immutable'
        })
        assert.equal((await getLog({ collectionId })).status, 404)
      }
    },
    {
      id: 'governed-log.not-a-resource',
      name: '[root] the log is absent from the listing, exempt from the envelope rule, and untouched by a PUT /meta',
      specRefs: [
        'https://w3id.org/pws#list-collection-operation',
        'https://w3id.org/pws#update-or-create-by-id-collection-operation'
      ],
      run: async (ctx, state) => {
        const { alice, collectionUrl, getLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, etag } = await governedCollection()
        const itemsUrl = `${collectionUrl(collectionId)}/`

        // The governed Collection is encrypted: a plaintext Resource is
        // refused by the envelope rule while a conforming envelope lands. The
        // log itself (JSON Lines, no envelope) was accepted above regardless.
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: itemsUrl,
            method: 'POST',
            action: 'POST',
            json: { hello: 'world' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the plaintext write to be refused')
        assert.equal(expectedError.response.status, 422)
        const created = await alice.rootClient.request({
          url: itemsUrl,
          method: 'POST',
          action: 'POST',
          json: edvDocument
        })
        assert.equal(created.status, 201)

        // One Resource in the listing, and it is not the log.
        const listing = await alice.rootClient.request({
          url: itemsUrl,
          method: 'GET'
        })
        const ids: string[] = listing.data.items.map((item: any) => item.id)
        assert.equal(ids.length, 1)
        assert.ok(!ids.some(id => /log|meta/.test(id)))

        // A `/meta` write leaves the log (and its ETag) alone.
        const meta = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'PUT',
          action: 'PUT',
          json: { custom: edvDocument }
        })
        assert.equal(meta.status, 204)
        assert.equal((await getLog({ collectionId })).headers.get('etag'), etag)
      }
    },
    {
      id: 'governed-log.delegated-read',
      name: '[delegated] a GET capability on the Collection URL covers the log read',
      run: async (ctx, state) => {
        const { alice, collectionUrl, getLog, governedCollection } = state
        const { aliceDelegatedApp } = ctx.actors
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body } = await governedCollection()
        // A Space-rooted grant: the chain descends from the Space's root
        // capability to the Collection's items subtree, which the log URL
        // sits under.
        const capability = await alice.pws.grant({
          to: aliceDelegatedApp.did,
          actions: ['GET'],
          target: `${collectionUrl(collectionId)}/`,
          spaceUrl: alice.space1.url
        })
        const read = await getLog({
          collectionId,
          invocationSigner: aliceDelegatedApp.signer,
          capability
        })
        assert.equal(read.status, 200)
        assert.equal(await read.text(), body)
      }
    },
    {
      id: 'governed-log.other-controller-404-mask',
      name: "[root] another controller's log read is the 404 mask, not a 403",
      specRefs: ['https://w3id.org/pws#not-found'],
      run: async (ctx, state) => {
        const { bob, getLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId } = await governedCollection()
        await assertProblem({
          response: await getLog({
            collectionId,
            invocationSigner: bob.signer
          }),
          status: 404,
          type: 'not-found'
        })
      }
    },
    {
      id: 'governed-log.delete-collection-removes-log',
      name: '[root] deleting the Collection takes the log with it: a re-created Collection is ungoverned',
      specRefs: ['https://w3id.org/pws#delete-collection-operation'],
      run: async (ctx, state) => {
        const { alice, collectionUrl, putLog, governedCollection } = state
        if (!state.governedSupported) {
          ctx.skip('the server does not advertise governed-history-logs')
        }
        const { collectionId, body } = await governedCollection()
        await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/`,
          method: 'DELETE'
        })
        await alice.rootClient.request({
          url: new URL(`/space/${alice.space1.id}/`, ctx.serverUrl).toString(),
          method: 'POST',
          action: 'POST',
          json: { id: collectionId, name: collectionId }
        })
        const described = await alice.rootClient.request({
          url: `${collectionUrl(collectionId)}/meta`,
          method: 'GET'
        })
        assert.equal(described.data.encryption, undefined)
        const recreated = await putLog({
          collectionId,
          body,
          headers: { 'if-none-match': '*' }
        })
        assert.equal(recreated.status, 204, await recreated.text())
      }
    }
  ]
}
