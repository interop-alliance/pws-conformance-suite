/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * PWS conformance tests -- the masked denial is the same response as an
 * absent target's.
 *
 * The spec's Error Handling makes it a MUST that a target the caller may not
 * read is indistinguishable from one that does not exist. The
 * `authz-ordering-api` and `denial-reasons-api` suites check the status and
 * the problem `type`. A server can pass both while its `title` or `detail`
 * differs between the two paths ("Space not found" against "URL not found"),
 * and that difference tells an unauthorized caller which targets exist.
 *
 * Every case here probes one operation twice, once at an absent target and
 * once at an existing target the caller may not see. It compares the status,
 * the `Content-Type` and the raw body text. The body is not parsed, since key
 * order and whitespace can differ too. Requests go out over `fetch`, so
 * nothing a client library normalizes can hide a difference.
 *
 * The signed probes are Bob's root invocations against Alice's targets. Each
 * is well formed, and signed by a key her targets did not delegate to. The
 * anonymous probes carry no authorization at all. A server may answer those
 * 401 or 404, and the two answers must still match.
 *
 * The keystore cases are optional and skip when the server has no `/kms`
 * facet, which the spec does not define. They also skip when the keystore
 * could not be created, and the skip reason says why. The revocation case is
 * optional for the same reason, and skips when the server has no revocation
 * endpoint. The Create Space case is optional too. The spec's note on Create
 * Space errors accepts the 409 there as a disclosure inherent to the
 * operation.
 */
import { generateId as generateBnid } from '@digitalcredentials/bnid'
import {
  canonicalBaseServerUrl,
  collectionUrl,
  resourceUrl,
  spacesRepositoryUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import type { ISigner } from '@interop/data-integrity-core'
import assert from '../harness/assert.js'
import { signedRequest } from '../helpers.js'
import type { Suite, TestCase } from '../harness/types.js'

/** One probed response, reduced to what the comparison reads. */
interface Probe {
  status: number
  contentType: string | null
  text: string
}

/** The two URLs one comparison probes. */
interface TargetPair {
  absent: string
  existing: string
}

interface State {
  alice: any
  bob: any
  spaceId: string
  space: TargetPair
  collection: TargetPair
  resource: TargetPair
  /** Absent when the server created no keystore for the suite. */
  keystore?: TargetPair
  /** Why `keystore` is absent, as the keystore cases' skip reason. */
  keystoreSkipReason?: string
  /** URLs of Spaces a case may have left behind, for teardown. */
  straySpaceUrls: string[]
}

const ID_CONFLICT = 'https://w3id.org/pws#id-conflict'
const ERROR_HANDLING = 'https://w3id.org/pws#error-handling'
const NOT_FOUND = 'https://w3id.org/pws#not-found'

/**
 * Sends a request and reduces the response to what the comparison reads. With
 * a `signer` the request is a root capability invocation of `url` signed by
 * that key. Without one it carries no authorization at all.
 *
 * @param options {object}
 * @param options.url {string}   the absolute URL to request
 * @param [options.method] {string}   the HTTP method (default `GET`)
 * @param [options.action] {string}   the capability action (default: the
 *   method's own)
 * @param [options.json] {object}   a JSON request body
 * @param [options.signer] {ISigner}   the invoking key; omit for an anonymous
 *   request
 * @returns {Promise<Probe>}
 */
async function probe({
  url,
  method = 'GET',
  action,
  json,
  signer
}: {
  url: string
  method?: string
  action?: string
  json?: object
  signer?: ISigner
}): Promise<Probe> {
  const response = signer
    ? await signedRequest({
        url,
        method,
        action,
        json,
        invocationSigner: signer
      })
    : await fetch(url, {
        method,
        ...(json && {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json)
        })
      })
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text()
  }
}

/**
 * Asserts two probed responses are the same response: same status, same
 * `Content-Type`, same body text.
 *
 * @param options {object}
 * @param options.absent {Probe}   the probe at an absent target
 * @param options.denied {Probe}   the probe at an existing, unreadable target
 */
function assertIndistinguishable({
  absent,
  denied
}: {
  absent: Probe
  denied: Probe
}): void {
  assert.equal(
    denied.status,
    absent.status,
    `status differs (absent ${absent.status}, existing ${denied.status})`
  )
  assert.equal(
    denied.contentType,
    absent.contentType,
    `Content-Type differs (absent ${absent.contentType}, ` +
      `existing ${denied.contentType})`
  )
  assert.equal(
    denied.text,
    absent.text,
    `body differs\nabsent: ${absent.text}\nexisting: ${denied.text}`
  )
}

/**
 * Creates a WebKMS keystore for Alice and pairs its URL with an absent
 * keystore URL of the same id format. When the server creates none, it
 * returns the reason instead, which the keystore cases skip with. A 404, 405
 * or 501 reads as "no `/kms` facet". Any other failure is reported as itself.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.alice {any}   the keystore's controller
 * @returns {Promise<{ keystore?: TargetPair, keystoreSkipReason?: string }>}
 */
async function createKeystorePair({
  serverUrl,
  alice
}: {
  serverUrl: string
  alice: any
}): Promise<{ keystore?: TargetPair; keystoreSkipReason?: string }> {
  const keystoresUrl = `${canonicalBaseServerUrl(serverUrl)}kms/keystores`
  let existing: unknown
  try {
    // The webkms protocol's actions are `read` and `write`, not HTTP verbs.
    const response = await alice.rootClient.request({
      url: keystoresUrl,
      method: 'POST',
      action: 'write',
      json: { sequence: 0, controller: alice.did }
    })
    existing = response.data?.id
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status
    if ([404, 405, 501].includes(status)) {
      return { keystoreSkipReason: 'the server has no /kms facet' }
    }
    const cause = status ?? err?.message ?? String(err)
    return { keystoreSkipReason: `keystore creation failed (${cause})` }
  }
  if (typeof existing !== 'string') {
    return { keystoreSkipReason: 'keystore creation returned no keystore id' }
  }
  // The same id format a webkms server mints, so no id-format check answers
  // the absent probe ahead of the lookup.
  const absentId = await generateBnid({ multihash: true })
  return { keystore: { existing, absent: `${keystoresUrl}/${absentId}` } }
}

/**
 * Builds one read case: the same read at an absent target and at an existing
 * one, signed by Bob or unsigned.
 *
 * @param options {object}
 * @param options.id {string}   the case id
 * @param options.kind {string}   the State member holding the target pair
 * @param options.label {string}   the target kind, for the case name
 * @param options.signed {boolean}   Bob's signed read, or an unsigned one
 * @param [options.action] {string}   the capability action, where it is not
 *   the HTTP method
 * @param [options.optional] {boolean}   marks a target the spec does not
 *   define
 * @returns {TestCase<State>}
 */
function readCase({
  id,
  kind,
  label,
  signed,
  action,
  optional
}: {
  id: string
  kind: 'space' | 'collection' | 'resource' | 'keystore'
  label: string
  signed: boolean
  action?: string
  optional?: boolean
}): TestCase<State> {
  const subject = `an absent ${label} and an unreadable one`
  return {
    id,
    name: signed
      ? `[cross-controller] ${subject} answer Bob's signed read with the same 404`
      : `[anonymous] ${subject} answer an unsigned read with the same response`,
    optional,
    specRefs: [ERROR_HANDLING, NOT_FOUND],
    run: async (ctx, state) => {
      const pair = state[kind]
      if (pair === undefined) {
        return ctx.skip(
          state.keystoreSkipReason ?? 'the server has no /kms facet'
        )
      }
      const request = {
        action,
        signer: signed ? (state.bob.signer as ISigner) : undefined
      }
      const absent = await probe({ url: pair.absent, ...request })
      const denied = await probe({ url: pair.existing, ...request })
      // An unsigned read may be 401 or 404. A signed one is the mask.
      assert.ok(
        absent.status === 404 || (!signed && absent.status === 401),
        `expected ${signed ? '404' : '401 or 404'} at the absent target, ` +
          `got ${absent.status}`
      )
      assertIndistinguishable({ absent, denied })
    }
  }
}

// A keystore read is the webkms `read` action, and the spec defines no
// keystores, so those two cases are optional.
const KEYSTORE = {
  kind: 'keystore',
  label: 'keystore',
  action: 'read',
  optional: true
} as const

export const maskedDenialApi: Suite<State> = {
  id: 'masked-denial-api',
  name: 'Masked denials are indistinguishable from absent targets',
  specRefs: [ERROR_HANDLING],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }
    const { serverUrl } = ctx
    const spaceId = ctx.generateId()
    const spaceUrl = spaceUrlById({ baseServerUrl: serverUrl, spaceId })
    const collectionId = 'credentials'
    const resourceId = ctx.generateId()

    await ctx.createSpace({
      spaceDescription: {
        id: spaceId,
        name: "Alice's Masked Denial Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // No policy makes the Collection publicly readable, so a read needs a
    // capability.
    await alice.rootClient.request({
      url: spaceUrl,
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Verifiable Credentials' }
    })
    const docUrl = resourceUrl({ spaceUrl, collectionId, resourceId })
    await alice.rootClient.request({
      url: docUrl,
      method: 'PUT',
      action: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })

    return {
      alice,
      bob,
      spaceId,
      space: {
        existing: spaceUrl,
        absent: spaceUrlById({
          baseServerUrl: serverUrl,
          spaceId: ctx.generateId()
        })
      },
      collection: {
        existing: collectionUrl({ spaceUrl, collectionId }),
        absent: collectionUrl({ spaceUrl, collectionId: ctx.generateId() })
      },
      resource: {
        existing: docUrl,
        absent: resourceUrl({
          spaceUrl,
          collectionId,
          resourceId: ctx.generateId()
        })
      },
      ...(await createKeystorePair({ serverUrl, alice })),
      straySpaceUrls: []
    }
  },

  teardown: async (ctx, state) => {
    for (const url of [state.space.existing, ...state.straySpaceUrls]) {
      try {
        await state.alice.rootClient.request({ url, method: 'DELETE' })
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  tests: [
    readCase({
      id: 'masked-denial.space-signed',
      kind: 'space',
      label: 'Space',
      signed: true
    }),
    readCase({
      id: 'masked-denial.collection-signed',
      kind: 'collection',
      label: 'Collection',
      signed: true
    }),
    readCase({
      id: 'masked-denial.resource-signed',
      kind: 'resource',
      label: 'Resource',
      signed: true
    }),
    readCase({
      id: 'masked-denial.keystore-signed',
      ...KEYSTORE,
      signed: true
    }),
    readCase({
      id: 'masked-denial.space-anonymous',
      kind: 'space',
      label: 'Space',
      signed: false
    }),
    readCase({
      id: 'masked-denial.collection-anonymous',
      kind: 'collection',
      label: 'Collection',
      signed: false
    }),
    readCase({
      id: 'masked-denial.resource-anonymous',
      kind: 'resource',
      label: 'Resource',
      signed: false
    }),
    readCase({
      id: 'masked-denial.keystore-anonymous',
      ...KEYSTORE,
      signed: false
    }),
    {
      id: 'masked-denial.revocation-malformed-body',
      name: "[cross-controller] Bob's revocation POST with a malformed body answers the same 404 whether or not the Space exists",
      optional: true,
      specRefs: [ERROR_HANDLING, NOT_FOUND],
      run: async (ctx, state) => {
        // Authorization MUST run before the body is validated. A 400 at the
        // existing Space alone would tell Bob the Space is there.
        const suffix = `zcaps/revocations/${encodeURIComponent(
          `urn:uuid:${ctx.generateId()}`
        )}`
        const request = {
          method: 'POST',
          json: { not: 'a capability' },
          signer: state.bob.signer as ISigner
        }
        const absent = await probe({
          url: `${state.space.absent}${suffix}`,
          ...request
        })
        const denied = await probe({
          url: `${state.space.existing}${suffix}`,
          ...request
        })
        assertIndistinguishable({ absent, denied })
        if ([405, 501].includes(absent.status)) {
          ctx.skip('zcap revocation endpoint not implemented')
        }
        assert.equal(absent.status, 404)
      }
    },
    {
      id: 'masked-denial.create-space-no-id-conflict',
      name: "[cross-controller] Bob's Create Space naming an existing id is not answered id-conflict (409)",
      optional: true,
      specRefs: [ERROR_HANDLING, ID_CONFLICT],
      run: async (ctx, state) => {
        const { alice, bob, spaceId } = state
        // Bob signs a create that names Alice as controller, so she has not
        // consented to it. A server that checks the id first tells any caller
        // which Space ids exist. The spec's Create Space note calls the 409
        // disclosure inherent to the operation, so the case is optional.
        const url = spacesRepositoryUrl({ baseServerUrl: ctx.serverUrl })
        const freshId = ctx.generateId()
        // Should the server create the fresh Space for Bob, Alice controls it
        // and teardown removes it.
        state.straySpaceUrls.push(
          spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId: freshId })
        )
        const existing = await probe({
          url,
          method: 'POST',
          json: { id: spaceId, controller: alice.did },
          signer: bob.signer
        })
        const fresh = await probe({
          url,
          method: 'POST',
          json: { id: freshId, controller: alice.did },
          signer: bob.signer
        })
        assert.notEqual(existing.status, 409)
        assert.ok(
          !existing.text.includes(ID_CONFLICT),
          `the existing id was answered as id-conflict: ${existing.text}`
        )
        assertIndistinguishable({ absent: fresh, denied: existing })
      }
    }
  ]
}
