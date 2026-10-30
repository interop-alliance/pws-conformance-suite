/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { ZcapClient } from '@interop/ezcap'
import { WasClient } from '@interop/was-client'
import {
  spaceMetaUrl,
  spacesRepositoryUrl,
  spaceUrlById
} from '@interop/was-client/paths'
import type { Space } from '@interop/was-client'
import { decodeSecretKeySeed } from '@digitalcredentials/bnid'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ISigner } from '@interop/data-integrity-core'
import { v4 as uuidv4 } from 'uuid'

import assert from './harness/assert.js'
import { serviceFeatures } from './harness/serviceDescription.js'
import type { Actors, ConformanceContext } from './harness/types.js'

/**
 * Deterministic test-identity seeds. Publishing them is a feature: a server
 * operator can pre-authorize these identities if needed.
 */
const secretKeySeeds = {
  alice: 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX',
  aliceDelegatedApp: 'z1AeeM8yN1D3cM56LsPmr3fFKuyv7MC4tdRkeiujMkyRy2u',
  bob: 'z1AmpBeBetWxKMBpAcHsztGogaUki1LXWANSzTd5CiYoikA',
  bobDelegatedApp: 'z1AfgF2HQvQaaAhod3KEYUHwY5epGtP5QmbEMKtMFf8XcYk'
}

/**
 * The suite's ZcapClient: delegation proofs are signed with `eddsa-jcs-2022`,
 * which canonicalizes with JCS and so needs no JSON-LD document loader at
 * signing time. That is what WAS clients now emit, so the required tests
 * exercise the suite a server actually meets. `Ed25519Signature2020` is not
 * gone from the suite: the optional `delegation-cryptosuites` suite asserts a
 * server still accepts it, and accepts a chain that mixes the two.
 *
 * @param options {object}
 * @param options.signer {ISigner}
 * @returns {ZcapClient}
 */
export function zcapClient({ signer }: { signer: ISigner }): ZcapClient {
  return new ZcapClient({
    SuiteClass: EddsaJcs2022,
    invocationSigner: signer,
    delegationSigner: signer
  })
}

/**
 * Builds a high-level WAS client wrapping a ZcapClient for the given signer.
 * The `serverUrl` is the server's base server URL, passed to the client as
 * `baseServerUrl`.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.signer {ISigner}
 * @returns {WasClient}
 */
export function wasClient({
  serverUrl,
  signer
}: {
  serverUrl: string
  signer: ISigner
}): WasClient {
  return new WasClient({
    baseServerUrl: serverUrl,
    zcapClient: zcapClient({ signer })
  })
}

export async function buildZcapClients({
  serverUrl
}: {
  serverUrl: string
}): Promise<Actors> {
  const aliceKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.alice })
  })
  const aliceRootDid = `did:key:${aliceKeyPair.fingerprint()}`
  const aliceSigner = aliceKeyPair.didKeySigner()

  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({
      secretKeySeed: secretKeySeeds.aliceDelegatedApp
    })
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`

  const bobKeyPair = await Ed25519VerificationKey.generate({
    seed: decodeSecretKeySeed({ secretKeySeed: secretKeySeeds.bob })
  })
  const bobRootDid = `did:key:${bobKeyPair.fingerprint()}`
  const bobSigner = bobKeyPair.didKeySigner()

  return {
    alice: {
      did: aliceRootDid,
      signer: aliceSigner,
      // Low-level ZcapClient -- kept for raw request()/delegate() calls.
      rootClient: zcapClient({ signer: aliceSigner }),
      // High-level WAS client wrapping the same signer.
      was: wasClient({ serverUrl, signer: aliceSigner })
    },
    aliceDelegatedApp: {
      did: aliceDelegatedAppDid,
      signer: aliceDelegatedAppKeyPair.didKeySigner()
    },
    bob: {
      did: bobRootDid,
      signer: bobSigner,
      rootClient: zcapClient({ signer: bobSigner }),
      was: wasClient({ serverUrl, signer: bobSigner })
    }
  }
}

/**
 * `POST`s a Space description to the Spaces Repository with an onboarding
 * token: the unsigned, `Authorization: Bearer` wire form a server that gates
 * provisioning accepts. Returns the raw response for the caller to interpret.
 */
async function postSpaceWithToken({
  serverUrl,
  onboardingToken,
  spaceDescription
}: {
  serverUrl: string
  onboardingToken: string
  spaceDescription: object
}): Promise<Response> {
  return fetch(spacesRepositoryUrl({ baseServerUrl: serverUrl }), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${onboardingToken}`
    },
    body: JSON.stringify(spaceDescription)
  })
}

/**
 * Creates a space on the server using an onboarding token (if configured) or
 * the WAS client. Returns a normalized response object for consistent
 * assertion.
 *
 * The ZCap path goes through `WasClient.request()` -- the client's signed
 * escape hatch -- so the conformance harness exercises the client while still
 * surfacing the raw status/headers/data the create-space assertions rely on.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.onboardingToken {string|null}
 * @param options.spaceDescription {object}
 * @param options.rootClient {ZcapClient} ZCap client -- used when no onboarding
 *   token is set
 * @returns {Promise<{status: number, headers: Headers, data: any}>}
 */
export async function createSpace({
  serverUrl,
  onboardingToken,
  spaceDescription,
  rootClient
}: {
  serverUrl: string
  onboardingToken: string | null
  spaceDescription: object
  rootClient: ZcapClient
}): Promise<{ status: number; headers: Headers; data: any }> {
  if (onboardingToken) {
    const response = await postSpaceWithToken({
      serverUrl,
      onboardingToken,
      spaceDescription
    })
    const data = await response.json()
    return { status: response.status, headers: response.headers, data }
  }
  const was = new WasClient({
    baseServerUrl: serverUrl,
    zcapClient: rootClient
  })
  const response = await was.request({
    url: spacesRepositoryUrl({ baseServerUrl: serverUrl }),
    method: 'POST',
    json: spaceDescription
  })
  return {
    status: response.status,
    headers: response.headers,
    data: response.data
  }
}

/**
 * Creates a Space by id with a `PUT` of its Space Metadata object (spec
 * "Update (or Create by Id) Space Operation"). With an onboarding token
 * configured, the `PUT` is unsigned and carries `Authorization: Bearer`, since
 * a server that gates provisioning gates this create path too. Otherwise it is
 * a root invocation signed by `rootClient`, which throws on a non-2xx status.
 * Returns a normalized response object, as `createSpace` does.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.onboardingToken {string|null}
 * @param options.spaceId {string}
 * @param options.spaceDescription {object}
 * @param options.rootClient {ZcapClient} ZCap client -- used when no onboarding
 *   token is set
 * @param [options.headers] {Record<string, string>} extra request headers,
 *   e.g. a precondition
 * @returns {Promise<{status: number, headers: Headers, data: any}>}
 */
export async function createSpaceByPut({
  serverUrl,
  onboardingToken,
  spaceId,
  spaceDescription,
  rootClient,
  headers = {}
}: {
  serverUrl: string
  onboardingToken: string | null
  spaceId: string
  spaceDescription: object
  rootClient: ZcapClient
  headers?: Record<string, string>
}): Promise<{ status: number; headers: Headers; data: any }> {
  const metaUrl = spaceMetaUrl({
    spaceUrl: spaceUrlById({ baseServerUrl: serverUrl, spaceId })
  })
  if (onboardingToken) {
    const response = await fetch(metaUrl, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${onboardingToken}`
      },
      body: JSON.stringify(spaceDescription)
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : undefined
    return { status: response.status, headers: response.headers, data }
  }
  const response = await rootClient.request({
    url: metaUrl,
    method: 'PUT',
    action: 'PUT',
    json: spaceDescription,
    headers
  })
  return {
    status: response.status,
    headers: response.headers,
    data: response.data
  }
}

/**
 * Provisions a Space for the high-level `WasClient` suites: with an onboarding
 * token configured, creates it via the token path (a plain fetch with
 * `Authorization: Bearer`, the same wire form `createSpace` above uses) and
 * returns the client's lazy handle to the new id; otherwise delegates to the
 * client's own signed `createSpace`. This is what lets the client suites run
 * against a server that gates provisioning behind an onboarding token.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.onboardingToken {string|null}
 * @param options.was {WasClient} the suite's high-level client
 * @param [options.name] {string} optional Space name
 * @returns {Promise<Space>}
 */
export async function provisionSpace({
  serverUrl,
  onboardingToken,
  was,
  name
}: {
  serverUrl: string
  onboardingToken: string | null
  was: WasClient
  name?: string
}): Promise<Space> {
  if (!onboardingToken) {
    return was.createSpace({ name })
  }
  const id = uuidv4()
  const response = await postSpaceWithToken({
    serverUrl,
    onboardingToken,
    spaceDescription: { id, name, controller: was.controllerDid }
  })
  if (response.status !== 201) {
    throw new Error(
      `Onboarding-token Create Space failed with status ${response.status}`
    )
  }
  return was.space(id)
}

/**
 * Strips a `createdBy` property from a Space/Collection description, if
 * present, before an exact-shape comparison. The spec makes `createdBy`
 * OPTIONAL ("a client MUST treat an absent `createdBy` as not recorded"), so a
 * conforming external server may legitimately omit it -- and one that records
 * it may report a creator this suite cannot predict. Either way the conformance
 * suite must not assert on it.
 *
 * @param value {unknown}
 * @returns {unknown}
 */
export function withoutCreatedBy(value: unknown): unknown {
  if (value && typeof value === 'object' && 'createdBy' in value) {
    const { createdBy: _createdBy, ...rest } = value as Record<string, unknown>
    return rest
  }
  return value
}

/**
 * Checks the write stamp a versioned record carries (`updatedAt`,
 * `updatedAtCounter`, `originId`) and returns the record without it, for an
 * exact-shape comparison of the rest. Every write mints the stamp at the origin
 * store: `updatedAt` is an RFC 3339 `date-time`, `updatedAtCounter` a
 * non-negative integer that ticks when the millisecond did not advance, and
 * `originId` the minting store's id, matching `[A-Za-z0-9_-]{1,64}`.
 *
 * @param value {unknown}   a Space, Collection, or Resource Metadata object,
 *   or a change document
 * @returns {Record<string, unknown>}   the record minus the three members
 */
export function withoutWriteStamp(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object', 'expected a record object')
  const { updatedAt, updatedAtCounter, originId, ...rest } = value as Record<
    string,
    unknown
  >
  assertWriteStamp({ updatedAt, updatedAtCounter, originId })
  return rest
}

/**
 * Checks the `replicas` member of a Space Metadata object, when the server
 * sends one, and returns the object without it, for an exact-shape comparison
 * of the rest. The member is server-derived and OPTIONAL: a server that
 * replicates Spaces lists each replica registration there as `fromSpace`,
 * `toSpace`, and `role`, and a server that does not omits it.
 *
 * @param value {unknown}   a Space Metadata object
 * @returns {Record<string, unknown>}   the object minus `replicas`
 */
export function withoutReplicas(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object', 'expected a record object')
  const { replicas, ...rest } = value as Record<string, unknown>
  if (replicas !== undefined) {
    assert.ok(Array.isArray(replicas), '`replicas` must be an array')
    for (const replica of replicas as Record<string, unknown>[]) {
      assert.equal(typeof replica.fromSpace, 'string')
      assert.equal(typeof replica.toSpace, 'string')
      assert.equal(typeof replica.role, 'string')
    }
  }
  return rest
}

/**
 * Checks the `created` member of a Collection Metadata object, when the server
 * sends one, and returns the object without it, for an exact-shape comparison
 * of the rest. The member is server-managed and OPTIONAL: it is the write
 * stamp of the write that created the Collection.
 *
 * @param value {unknown}   a Collection Metadata object
 * @returns {Record<string, unknown>}   the object minus `created`
 */
export function withoutCreatingStamp(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object', 'expected a record object')
  const { created, ...rest } = value as Record<string, unknown>
  if (created !== undefined) {
    assert.ok(
      created && typeof created === 'object',
      '`created` must be a write stamp object'
    )
    assertWriteStamp(created as Record<string, unknown>)
  }
  return rest
}

/**
 * Asserts the three write-stamp members are present and well-formed.
 *
 * @param stamp {object}   the stamp members read off a record
 */
export function assertWriteStamp(stamp: Record<string, unknown>): void {
  assert.equal(
    typeof stamp.updatedAt,
    'string',
    'expected a string `updatedAt` stamp member'
  )
  assert.ok(
    !Number.isNaN(Date.parse(stamp.updatedAt as string)),
    '`updatedAt` must be an RFC 3339 date-time'
  )
  assert.ok(
    Number.isInteger(stamp.updatedAtCounter) &&
      (stamp.updatedAtCounter as number) >= 0,
    '`updatedAtCounter` must be a non-negative integer'
  )
  assert.ok(
    typeof stamp.originId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(stamp.originId),
    '`originId` must match [A-Za-z0-9_-]{1,64}'
  )
}

/**
 * The members a Resource write response body may carry: the server-managed
 * members of the Resource Metadata object.
 */
const WRITE_RESPONSE_MEMBERS = new Set([
  'contentType',
  'size',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedAtCounter',
  'originId',
  'meta'
])

/**
 * Checks the answer to a Resource write: Create or Update Resource by id, or
 * Update Resource Metadata. A content write answers `201` when it created the
 * Resource and `200` when it updated it. A metadata write never creates, so it
 * answers `200`. A server MAY answer `204` with no body instead. A `2xx` that
 * carries a body carries only the server-managed members: `contentType`,
 * `size`, and the write stamp always, `createdAt` and `createdBy` only on a
 * `201`, and the `/meta` record's stamp under `meta` only on a metadata write.
 *
 * @param options {object}
 * @param options.response {any}   the write's response
 * @param options.created {boolean}   whether the write creates the Resource
 * @param [options.metaWrite] {boolean}   whether it is a metadata write
 */
export function assertResourceWriteResponse({
  response,
  created,
  metaWrite = false
}: {
  response: any
  created: boolean
  metaWrite?: boolean
}): void {
  const success = created ? 201 : 200
  assert.ok(
    response.status === success || response.status === 204,
    `expected ${success} or 204, got ${response.status}`
  )
  const body = response.data
  if (response.status === 204 || body === undefined || body === '') {
    return
  }
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/json/,
    'expected a JSON write response body'
  )
  assert.ok(
    body && typeof body === 'object' && !Array.isArray(body),
    'expected the write response body to be a JSON object'
  )
  for (const member of Object.keys(body)) {
    assert.ok(
      WRITE_RESPONSE_MEMBERS.has(member),
      `unexpected member \`${member}\` in the write response body`
    )
  }
  assert.equal(typeof body.contentType, 'string', 'expected `contentType`')
  assert.ok(
    Number.isInteger(body.size) && body.size >= 0,
    '`size` must be a non-negative integer'
  )
  assertWriteStamp(body)
  if (response.status === 201) {
    assert.equal(typeof body.createdAt, 'string', 'expected `createdAt`')
  } else {
    assert.equal(body.createdAt, undefined, '`createdAt` only on a 201')
    assert.equal(body.createdBy, undefined, '`createdBy` only on a 201')
  }
  if (metaWrite) {
    assertWriteStamp(body.meta ?? {})
    assert.equal(
      typeof body.meta.generation,
      'string',
      'expected the `meta` generation'
    )
  } else {
    assert.equal(body.meta, undefined, '`meta` only on a metadata write')
  }
}

/**
 * Checks the server-derived `backends` member of a Space Metadata object and
 * returns the object without it, for an exact-shape comparison of the rest.
 * The member is OPTIONAL (spec "Space Metadata Data Model"). A server that
 * advertises the `backends` feature carries the same listing
 * `GET /space/{space_id}/backends` serves. A server that does not omits it.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.metadata {unknown}   the Space Metadata object as served
 * @param options.readListing {Function}   reads the Space's backends listing
 * @returns {Promise<unknown>}
 */
export async function checkBackendsMember({
  serverUrl,
  metadata,
  readListing
}: {
  serverUrl: string
  metadata: unknown
  readListing: () => Promise<unknown>
}): Promise<unknown> {
  assert.ok(metadata && typeof metadata === 'object')
  const { backends, ...rest } = metadata as Record<string, unknown>
  const features = await serviceFeatures({ serverUrl })
  if (!features.includes('backends')) {
    assert.ok(
      !('backends' in metadata),
      'a server without the backends feature omits `backends`'
    )
    return rest
  }
  assert.ok(Array.isArray(backends), '`backends` must be an array')
  assert.deepStrictEqual(backends, await readListing())
  return rest
}

/**
 * Builds the per-run conformance context: the deterministic test identities
 * plus the provisioning/utility helpers bound to the target server.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param [options.onboardingToken] {string|null}
 * @returns {Promise<ConformanceContext>}
 */
export async function createContext({
  serverUrl,
  onboardingToken = null
}: {
  serverUrl: string
  onboardingToken?: string | null
}): Promise<ConformanceContext> {
  const actors = await buildZcapClients({ serverUrl })
  return {
    serverUrl,
    onboardingToken,
    actors,
    createSpace: ({ spaceDescription, rootClient }) =>
      createSpace({ serverUrl, onboardingToken, spaceDescription, rootClient }),
    createSpaceByPut: ({ spaceId, spaceDescription, rootClient, headers }) =>
      createSpaceByPut({
        serverUrl,
        onboardingToken,
        spaceId,
        spaceDescription,
        rootClient,
        ...(headers && { headers })
      }),
    provisionSpace: ({ was, name }) =>
      provisionSpace({ serverUrl, onboardingToken, was, name }),
    wasClient: ({ signer }) => wasClient({ serverUrl, signer }),
    zcapClient,
    generateId: uuidv4,
    withoutCreatedBy
  }
}

export { uuidv4 as generateId }
