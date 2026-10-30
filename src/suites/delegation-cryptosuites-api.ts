/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- delegation-proof cryptosuites (OPTIONAL).
 *
 * A delegated capability's `proof` is a signature on the document, separate
 * from the capability invocation's HTTP signature. This suite asserts a server
 * accepts both cryptosuites in use, rather than the run silently tracking
 * whichever one it happens to send.
 *
 * The two are not on the same footing. The rest of this conformance suite signs
 * its delegations with `eddsa-jcs-2022`, which canonicalizes with JCS and so
 * costs no JSON-LD canonicalization; that is what current PWS clients emit, so
 * every delegated test in the required set already depends on a server
 * accepting it, and the test for it here is required too.
 *
 * `Ed25519Signature2020` is the older suite, and its tests are marked optional:
 * a server may reasonably have moved past it, and the spec's authorization
 * profile names no cryptosuite at all. Accepting it is still what keeps two
 * populations working -- clients that have not upgraded, and wallets that
 * recorded a grant before the switch and submit that stored capability back for
 * revocation under the suite it was signed with.
 *
 * The two are told apart by `proof.type` and `proof.cryptosuite`, with no
 * heuristic, so a server may accept both at once and the links of a single
 * chain may mix them. The mixed-chain test here runs the one direction any
 * client can produce unaided: an `Ed25519Signature2020` parent with an
 * `eddsa-jcs-2022` child. The reverse needs the old-suite client to be handed a
 * document loader serving the data-integrity context -- URDNA2015 expands the
 * parent embedded in `proof.capabilityChain` -- and it throws at signing time,
 * on the client, before any server sees the chain. That is a client-side
 * limitation rather than a server property, so it is out of scope here.
 */
import { ZcapClient } from '@interop/ezcap'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import type { ISigner } from '@interop/data-integrity-core'

import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  bob: any
  docUrl: string
  spaceId: string
}

/**
 * A ZcapClient signing its delegation proofs with `Ed25519Signature2020` -- the
 * older suite, as a client that has not upgraded still sends it. The suite's
 * own `ctx.zcapClient` is the `eddsa-jcs-2022` counterpart.
 *
 * @param options {object}
 * @param options.signer {ISigner}
 * @returns {ZcapClient}
 */
function legacyZcapClient({ signer }: { signer: ISigner }): ZcapClient {
  return new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer
  })
}

/**
 * The delegation proof of a freshly delegated capability. `proof` may be a
 * single proof or a set of them; `delegate()` produces exactly one.
 *
 * @param capability {any}
 * @returns {Record<string, string>}
 */
function delegationProof(capability: any): Record<string, string> {
  const { proof } = capability
  return Array.isArray(proof) ? proof[0] : proof
}

export const delegationCryptosuitesApi: Suite<State> = {
  id: 'delegation-cryptosuites',
  name: 'Delegation-proof cryptosuites',
  specRefs: ['https://w3id.org/pws/authz-profile#delegation'],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const aliceDelegatedApp: any = { ...ctx.actors.aliceDelegatedApp }
    const bob: any = { ...ctx.actors.bob }
    const spaceId = ctx.generateId()
    const resourceId = ctx.generateId()

    await ctx.createSpace({
      spaceDescription: {
        id: spaceId,
        name: "Alice's Cryptosuite Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${spaceId}/`, ctx.serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
    const docUrl = new URL(
      `/space/${spaceId}/credentials/${resourceId}`,
      ctx.serverUrl
    ).toString()
    await alice.rootClient.request({
      url: docUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })

    return { alice, aliceDelegatedApp, bob, docUrl, spaceId }
  },

  teardown: async (ctx, state) => {
    try {
      await state.alice.rootClient.request({
        url: new URL(`/space/${state.spaceId}/`, ctx.serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'cryptosuites.eddsa-jcs-2022',
      name: 'accepts a delegation proof signed with eddsa-jcs-2022',
      specRefs: ['https://w3id.org/pws/authz-profile#delegation'],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, docUrl } = state
        const capability = await alice.rootClient.delegate({
          allowedActions: ['GET'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did
        })
        const proof = delegationProof(capability)
        assert.equal(proof.type, 'DataIntegrityProof')
        assert.equal(proof.cryptosuite, 'eddsa-jcs-2022')

        const response = await ctx
          .zcapClient({ signer: aliceDelegatedApp.signer })
          .request({ url: docUrl, method: 'GET', action: 'GET', capability })
        assert.equal(response.status, 200)
        assert.equal((response.data as any).hello, 'world')
      }
    },
    {
      id: 'cryptosuites.ed25519-signature-2020',
      name: 'accepts a delegation proof signed with Ed25519Signature2020',
      // Optional: the older suite, which a server may reasonably no longer
      // accept. The spec names no cryptosuite either way.
      optional: true,
      specRefs: ['https://w3id.org/pws/authz-profile#delegation'],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, docUrl } = state
        // Alice's own signer, but a client on the older suite -- the shape a
        // client that has not upgraded still sends.
        const capability = await legacyZcapClient({
          signer: alice.signer
        }).delegate({
          allowedActions: ['GET'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did
        })
        assert.equal(delegationProof(capability).type, 'Ed25519Signature2020')

        const response = await ctx
          .zcapClient({ signer: aliceDelegatedApp.signer })
          .request({ url: docUrl, method: 'GET', action: 'GET', capability })
        assert.equal(response.status, 200)
        assert.equal((response.data as any).hello, 'world')
      }
    },
    {
      id: 'cryptosuites.mixed-chain',
      name: 'accepts a chain whose links mix the two cryptosuites',
      // Optional for the same reason: its parent link is Ed25519Signature2020.
      optional: true,
      specRefs: ['https://w3id.org/pws/authz-profile#delegation'],
      run: async (ctx, state) => {
        const { alice, aliceDelegatedApp, bob, docUrl } = state
        // An Ed25519Signature2020 parent...
        const parent = await legacyZcapClient({
          signer: alice.signer
        }).delegate({
          allowedActions: ['GET'],
          invocationTarget: docUrl,
          controller: aliceDelegatedApp.did
        })
        // ...re-delegated by an upgraded client, so the child is JCS-signed.
        const child = await ctx
          .zcapClient({ signer: aliceDelegatedApp.signer })
          .delegate({
            capability: parent,
            allowedActions: ['GET'],
            controller: bob.did
          })
        assert.equal(delegationProof(child).cryptosuite, 'eddsa-jcs-2022')

        const response = await bob.rootClient.request({
          url: docUrl,
          method: 'GET',
          action: 'GET',
          capability: child
        })
        assert.equal(response.status, 200)
        assert.equal((response.data as any).hello, 'world')
      }
    }
  ]
}
