/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * PWS conformance tests -- `did:webvh` DID URLs as capability targets, gated
 * on the `did-url-targets` feature token of the authorization profile.
 *
 * A capability may name a DID URL such as `did:webvh:<scid>:<host>/photos/`
 * as its `invocationTarget`. A `PathHandler` service in the DID document maps
 * the path to an https URL, and the server decides on that URL. The request
 * is still an https request, so only the capabilities in the chain name DID
 * URLs.
 *
 * `setup()` provisions a Space controlled by a self-hosted `did:webvh`, so
 * the server resolves the DID from its own storage. The DID document has
 * three versions:
 *
 * - version 1 maps `/` to the Space;
 * - version 2 adds `/pics`, mapped to the `photos` Collection;
 * - version 3, the current one, maps `/pics` to the `albums` Collection. It
 *   adds `/other`, mapped to a second Space of the same controller, `/remote`,
 *   mapped to a Space URL on another host, and `/photos/up`, mapped to the
 *   Space URL from beneath the `photos` Collection.
 *
 * A client library refuses to send a DID URL capability to an https URL
 * without a dereferencer, so requests are signed with the low-level
 * `signCapabilityInvocation` primitive and sent over `fetch`. Every refusal
 * must be the masked `not-found`. Its status, `Content-Type` and body text are
 * compared with the answer a root invocation by an unrelated key collects at
 * the same URL.
 *
 * Every case skips when the token is absent, or when the server refuses a
 * `did:webvh` Space controller. The two revocation cases are optional, since
 * the profile does not define the revocation endpoint yet. They skip on a
 * server without one.
 */
import { updateDID } from '@interop/did-method-webvh'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import jsigs from '@interop/jsonld-signatures'
import {
  collectionUrl,
  resourceUrl,
  rootCapabilityId,
  spaceUrlById
} from '@interop/pws-client/paths'
import { CapabilityDelegation } from '@interop/zcap'
import type { ISigner } from '@interop/data-integrity-core'
import type { IDelegatedZcap } from '@interop/data-integrity-core/zcap'
import assert from '../harness/assert.js'
import {
  AUTHZ_PROFILE_IDENTIFIER,
  serviceFeatures
} from '../harness/serviceDescription.js'
import {
  pathHandler,
  provisionWebvhSpace,
  publishWebvhLog,
  revokeOrSkip,
  signedRequest,
  SpaceControllerUpdateError,
  updateSpaceController
} from '../helpers.js'
import type {
  Actor,
  ConformanceContext,
  Suite,
  TestContext
} from '../harness/types.js'

/** What the cases share once the Space is provisioned. */
interface Provisioned {
  bob: Actor
  /** The `did:webvh` both Spaces are controlled by. */
  did: string
  /** The controller's signer, which signs root invocations and grants. */
  owner: ISigner
  /** A key no capability names, for the masked baseline. */
  rogue: ISigner
  spaceId: string
  spaceUrl: string
  /** The Space root capability in DID URL form: `<did>/` maps to the Space. */
  didRoot: string
  /** A second Space of the same controller, which `/other` maps to. */
  otherSpaceId: string
  otherSpaceUrl: string
}

interface State {
  /** Present when the suite could not run, as every case's skip reason. */
  skipReason?: string
  provisioned?: Provisioned
}

const NOT_FOUND = 'https://w3id.org/pws#not-found'
const CAPABILITY_REVOKED = 'https://w3id.org/pws#capability-revoked'
const CAPABILITY_EXPIRED = 'https://w3id.org/pws#capability-expired'
const INVALID_AUTHORIZATION_HEADER =
  'https://w3id.org/pws#invalid-authorization-header'

const ROOT_CAPABILITY = `${AUTHZ_PROFILE_IDENTIFIER}#did-url-root-capability`
const DELEGATION_CHAINS = `${AUTHZ_PROFILE_IDENTIFIER}#did-url-delegation-chains`
const SELECTORS = `${AUTHZ_PROFILE_IDENTIFIER}#did-url-selectors`
const DENIAL_CAUSES = `${AUTHZ_PROFILE_IDENTIFIER}#did-url-denial-causes`
const REVOCATION = `${AUTHZ_PROFILE_IDENTIFIER}#did-url-revocation`

/**
 * Returns what `setup()` provisioned, or skips the test when the server does
 * not advertise `did-url-targets` or could not be provisioned.
 *
 * @param ctx {TestContext}
 * @param state {State}
 * @returns {Provisioned}
 */
function requireProvisioned(ctx: TestContext, state: State): Provisioned {
  if (state.provisioned === undefined) {
    return ctx.skip(state.skipReason)
  }
  return state.provisioned
}

/**
 * The URL of a Resource in one of the suite's Spaces.
 *
 * @param spaceUrl {string}
 * @param collectionId {string}
 * @param resourceId {string}
 * @returns {string}
 */
function docUrl(
  spaceUrl: string,
  collectionId: string,
  resourceId: string
): string {
  return resourceUrl({ spaceUrl, collectionId, resourceId })
}

/**
 * Deletes a Space, ignoring a failure.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}
 * @param options.signer {ISigner}   the Space controller's signer
 * @param options.spaceUrl {string}
 * @returns {Promise<void>}
 */
async function deleteSpaceQuietly({
  ctx,
  signer,
  spaceUrl
}: {
  ctx: ConformanceContext
  signer: ISigner
  spaceUrl: string
}): Promise<void> {
  try {
    await ctx
      .zcapClient({ signer })
      .request({ url: spaceUrl, method: 'DELETE' })
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Delegates a GET capability to Bob with the checks a client makes on its own
 * grant. `parent` is a root capability id, or a delegated capability whose
 * expiry the new one inherits.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}
 * @param options.provisioned {Provisioned}
 * @param options.signer {ISigner}   the delegator
 * @param options.parent {string | IDelegatedZcap}
 * @param options.target {string}   the new capability's `invocationTarget`
 * @param [options.actions] {string[]}   defaults to `['GET']`
 * @param [options.now] {number}   backdates the grant, and with it the
 *   default expiry
 * @returns {Promise<IDelegatedZcap>}
 */
async function delegateToBob({
  ctx,
  provisioned,
  signer,
  parent,
  target,
  actions = ['GET'],
  now
}: {
  ctx: ConformanceContext
  provisioned: Provisioned
  signer: ISigner
  parent: string | IDelegatedZcap
  target: string
  actions?: string[]
  now?: number
}): Promise<IDelegatedZcap> {
  return ctx.zcapClient({ signer }).delegate({
    capability: parent,
    invocationTarget: target,
    controller: provisioned.bob.did,
    allowedActions: actions,
    ...(typeof parent !== 'string' && { expires: parent.expires }),
    ...(now !== undefined && { now })
  })
}

/**
 * Bob's grant on a DID URL path, delegated by the Space controller from the
 * DID URL root.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}
 * @param options.provisioned {Provisioned}
 * @param [options.path] {string}   appended to the DID; defaults to the
 *   `photos` Collection
 * @param [options.actions] {string[]}   defaults to `['GET']`
 * @param [options.now] {number}   backdates the grant
 * @returns {Promise<IDelegatedZcap>}
 */
async function grantToBob({
  ctx,
  provisioned,
  path = '/photos/',
  actions,
  now
}: {
  ctx: ConformanceContext
  provisioned: Provisioned
  path?: string
  actions?: string[]
  now?: number
}): Promise<IDelegatedZcap> {
  return delegateToBob({
    ctx,
    provisioned,
    signer: provisioned.owner,
    parent: provisioned.didRoot,
    target: `${provisioned.did}${path}`,
    actions,
    now
  })
}

/**
 * Bob delegates to himself from a delegated capability, without the checks a
 * client makes on its own grant, for a chain the server is to refuse. A
 * well-behaved client does not sign a child whose selector differs from its
 * parent's.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}
 * @param options.provisioned {Provisioned}
 * @param options.parent {IDelegatedZcap}   the parent capability
 * @param options.target {string}   the new capability's `invocationTarget`
 * @returns {Promise<IDelegatedZcap>}
 */
async function bobDelegatesUnchecked({
  ctx,
  provisioned,
  parent,
  target
}: {
  ctx: ConformanceContext
  provisioned: Provisioned
  parent: IDelegatedZcap
  target: string
}): Promise<IDelegatedZcap> {
  const { bob } = provisioned
  return (await jsigs.sign(
    {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:uuid:${ctx.generateId()}`,
      controller: bob.did,
      parentCapability: parent.id,
      invocationTarget: target,
      expires: parent.expires,
      allowedAction: ['GET']
    },
    {
      suite: new EddsaJcs2022({ signer: bob.signer }) as any,
      purpose: new CapabilityDelegation({
        parentCapability: parent as any,
        _skipLocalValidationForTesting: true
      }) as any
    } as any
  )) as IDelegatedZcap
}

/**
 * Bob's GET of a URL under a capability.
 *
 * @param options {object}
 * @param options.provisioned {Provisioned}
 * @param options.url {string}
 * @param options.capability {IDelegatedZcap}
 * @returns {Promise<Response>}
 */
async function bobGet({
  provisioned,
  url,
  capability
}: {
  provisioned: Provisioned
  url: string
  capability: IDelegatedZcap
}): Promise<Response> {
  return signedRequest({
    url,
    method: 'GET',
    invocationSigner: provisioned.bob.signer,
    capability
  })
}

/**
 * Asserts a refused GET is the masked `not-found`. It must be a 404 with the
 * same `Content-Type` and body text that a root invocation by an unrelated key
 * collects at the same URL.
 *
 * @param options {object}
 * @param options.provisioned {Provisioned}
 * @param options.response {Response}   the refusal under test
 * @param options.url {string}   the URL it was collected at
 * @returns {Promise<void>}
 */
async function assertMasked({
  provisioned,
  response,
  url
}: {
  provisioned: Provisioned
  response: Response
  url: string
}): Promise<void> {
  const baseline = await signedRequest({
    url,
    method: 'GET',
    invocationSigner: provisioned.rogue
  })
  const text = await response.text()
  const baselineText = await baseline.text()
  assert.equal(baseline.status, 404, 'unrelated-key baseline status')
  assert.equal(response.status, 404, `expected the masked 404; body: ${text}`)
  assert.equal(
    response.headers.get('content-type'),
    baseline.headers.get('content-type'),
    'Content-Type differs from the unrelated-key baseline'
  )
  assert.equal(
    text,
    baselineText,
    `body differs\nunrelated key: ${baselineText}\nrefusal: ${text}`
  )
}

/**
 * Bob's GET of a URL under a capability, asserted to be the masked
 * `not-found`.
 *
 * @param options {object}
 * @param options.provisioned {Provisioned}
 * @param options.url {string}
 * @param options.capability {IDelegatedZcap}
 * @returns {Promise<void>}
 */
async function assertBobMasked({
  provisioned,
  url,
  capability
}: {
  provisioned: Provisioned
  url: string
  capability: IDelegatedZcap
}): Promise<void> {
  const response = await bobGet({ provisioned, url, capability })
  await assertMasked({ provisioned, response, url })
}

/**
 * Asserts a GET answered 200 with a Resource of the named Collection.
 *
 * @param response {Response}
 * @param collectionId {string}
 * @returns {Promise<void>}
 */
async function assertReadFrom(
  response: Response,
  collectionId: string
): Promise<void> {
  assert.equal(response.status, 200)
  assert.equal((await response.json()).collection, collectionId)
}

/**
 * Asserts a write created a Resource: `201`, or `204` with no body.
 *
 * @param response {Response}
 */
function assertCreated(response: Response): void {
  assert.ok(
    response.status === 201 || response.status === 204,
    `expected 201 or 204, got ${response.status}`
  )
}

/**
 * Asserts a revoked grant is refused to its own holder. The answer is a 404
 * that names the revocation or is the plain `not-found`.
 *
 * @param response {Response}
 * @returns {Promise<void>}
 */
async function assertRefusedAsRevoked(response: Response): Promise<void> {
  assert.equal(response.status, 404)
  const problem: any = await response.json()
  assert.ok(
    [CAPABILITY_REVOKED, NOT_FOUND].includes(problem.type),
    `expected capability-revoked or not-found, got ${problem.type}`
  )
}

/**
 * Provisions the suite's two Spaces and publishes the three versions of the
 * DID document.
 *
 * @param ctx {ConformanceContext}
 * @returns {Promise<Provisioned>}
 * @throws {SpaceControllerUpdateError}   when the server does not accept the
 *   `did:webvh` controller
 */
async function provision(ctx: ConformanceContext): Promise<Provisioned> {
  const { alice, bob } = ctx.actors
  const space = await provisionWebvhSpace({
    ctx,
    owner: alice,
    name: 'DID URL Targets Space'
  })
  const { did, spaceId, spaceUrl, signer: owner } = space
  const ownerClient = ctx.zcapClient({ signer: owner })

  // A second Space of the same controller. It is created under Alice's
  // did:key, then updated to the did:webvh.
  const otherSpaceId = ctx.generateId()
  const otherSpaceUrl = spaceUrlById({
    baseServerUrl: ctx.serverUrl,
    spaceId: otherSpaceId
  })
  const otherDescription = { id: otherSpaceId, name: 'Other Space' }
  // The key that controls the second Space, which deletes it when a later
  // step fails. The runner skips teardown after a failed setup.
  let otherSpaceSigner = alice.signer
  try {
    const created = await ctx.createSpace({
      spaceDescription: { ...otherDescription, controller: alice.did },
      rootClient: alice.rootClient
    })
    assert.equal(created.status, 201)
    await updateSpaceController({
      spaceUrl: otherSpaceUrl,
      spaceDescription: { ...otherDescription, controller: did },
      signer: alice.signer
    })
    otherSpaceSigner = owner

    // `photos/doc-1` exists in both Spaces, so a grant on it that reached the
    // wrong Space would read something.
    const resources: Array<[string, string, string]> = [
      [spaceUrl, 'photos', 'doc-1'],
      [spaceUrl, 'albums', 'a-1'],
      [otherSpaceUrl, 'photos', 'doc-1']
    ]
    for (const [url, collectionId, resourceId] of resources) {
      await ownerClient.request({
        url,
        method: 'POST',
        action: 'POST',
        json: { id: collectionId, name: collectionId }
      })
      await ownerClient.request({
        url: docUrl(url, collectionId, resourceId),
        method: 'PUT',
        action: 'PUT',
        json: { id: resourceId, collection: collectionId }
      })
    }

    const root = pathHandler({ path: '/', serviceEndpoint: spaceUrl })
    const version2 = await updateDID({
      log: space.log,
      signer: space.logSigner,
      services: [
        root,
        pathHandler({
          path: '/pics',
          serviceEndpoint: collectionUrl({ spaceUrl, collectionId: 'photos' })
        })
      ]
    })
    const version3 = await updateDID({
      log: version2.log,
      signer: space.logSigner,
      services: [
        root,
        pathHandler({
          path: '/pics',
          serviceEndpoint: collectionUrl({ spaceUrl, collectionId: 'albums' })
        }),
        pathHandler({ path: '/other', serviceEndpoint: otherSpaceUrl }),
        pathHandler({
          path: '/remote',
          serviceEndpoint: `https://elsewhere.example/space/${spaceId}/`
        }),
        pathHandler({ path: '/photos/up', serviceEndpoint: spaceUrl })
      ]
    })
    await publishWebvhLog({
      logUrl: space.logUrl,
      log: version3.log,
      signer: owner
    })

    return {
      bob,
      did,
      owner,
      rogue: (await Ed25519VerificationKey.generate()).didKeySigner(),
      spaceId,
      spaceUrl,
      didRoot: rootCapabilityId(`${did}/`),
      otherSpaceId,
      otherSpaceUrl
    }
  } catch (err) {
    // The Space that holds the controller's log goes last.
    await deleteSpaceQuietly({
      ctx,
      signer: otherSpaceSigner,
      spaceUrl: otherSpaceUrl
    })
    await deleteSpaceQuietly({ ctx, signer: owner, spaceUrl })
    throw err
  }
}

export const didUrlTargetsApi: Suite<State> = {
  id: 'did-url-targets-api',
  name: 'DID URL capability targets',
  specRefs: [`${AUTHZ_PROFILE_IDENTIFIER}#did-url-targets`],

  setup: async ctx => {
    const features = await serviceFeatures({
      serverUrl: ctx.serverUrl,
      specIdentifier: AUTHZ_PROFILE_IDENTIFIER
    })
    if (!features.includes('did-url-targets')) {
      return {
        skipReason: 'the service description does not advertise did-url-targets'
      }
    }
    try {
      return { provisioned: await provision(ctx) }
    } catch (err) {
      // 400 is the spec's answer for a controller DID method the server does
      // not support, and `did:webvh` is OPTIONAL in that registry.
      if (err instanceof SpaceControllerUpdateError && err.status === 400) {
        return {
          skipReason: 'the server does not accept a did:webvh Space controller'
        }
      }
      throw err
    }
  },

  teardown: async (ctx, state) => {
    if (state.provisioned === undefined) {
      return
    }
    const { owner, spaceUrl, otherSpaceUrl } = state.provisioned
    // The Space that holds the controller's log goes last.
    for (const url of [otherSpaceUrl, spaceUrl]) {
      await deleteSpaceQuietly({ ctx, signer: owner, spaceUrl: url })
    }
  },

  tests: [
    {
      id: 'did-url-targets.root-read-write',
      name: '[root] the DID URL root capability reads and writes',
      specRefs: [ROOT_CAPABILITY],
      run: async (ctx, state) => {
        const { owner, spaceUrl, didRoot } = requireProvisioned(ctx, state)
        const read = await signedRequest({
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          method: 'GET',
          invocationSigner: owner,
          capability: didRoot
        })
        await assertReadFrom(read, 'photos')

        const resourceId = ctx.generateId()
        const written = await signedRequest({
          url: docUrl(spaceUrl, 'photos', resourceId),
          method: 'PUT',
          invocationSigner: owner,
          capability: didRoot,
          json: { id: resourceId }
        })
        assertCreated(written)
      }
    },
    {
      id: 'did-url-targets.delegated-read-write',
      name:
        '[delegated] a DID URL chain reads and writes beneath its ' +
        'dereferenced URL, and nowhere else',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { bob, spaceUrl } = provisioned
        const grant = await grantToBob({
          ctx,
          provisioned,
          actions: ['GET', 'PUT']
        })
        const read = await bobGet({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
        await assertReadFrom(read, 'photos')

        const resourceId = ctx.generateId()
        const written = await signedRequest({
          url: docUrl(spaceUrl, 'photos', resourceId),
          method: 'PUT',
          invocationSigner: bob.signer,
          capability: grant,
          json: { id: resourceId }
        })
        assertCreated(written)

        // Outside the Collection the target dereferences to.
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'albums', 'a-1'),
          capability: grant
        })
      }
    },
    {
      id: 'did-url-targets.https-root-did-link-refused',
      name:
        '[delegated] an https root with a DID URL link is refused ' +
        '(masked not-found)',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { did, owner, spaceUrl } = provisioned
        const httpsRoot = rootCapabilityId(spaceUrl)
        const url = docUrl(spaceUrl, 'photos', 'doc-1')

        // The same grant in https form throughout is admitted, so the
        // refusal below is about the mixed forms.
        const httpsGrant = await delegateToBob({
          ctx,
          provisioned,
          signer: owner,
          parent: httpsRoot,
          target: collectionUrl({ spaceUrl, collectionId: 'photos' })
        })
        const read = await bobGet({ provisioned, url, capability: httpsGrant })
        assert.equal(read.status, 200)

        const mixed = await delegateToBob({
          ctx,
          provisioned,
          signer: owner,
          parent: httpsRoot,
          target: `${did}/photos/`
        })
        await assertBobMasked({ provisioned, url, capability: mixed })
      }
    },
    {
      id: 'did-url-targets.did-root-https-link-refused',
      name:
        '[delegated] a DID URL root with an https link is refused ' +
        '(masked not-found)',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { owner, spaceUrl, didRoot } = provisioned
        const mixed = await delegateToBob({
          ctx,
          provisioned,
          signer: owner,
          parent: didRoot,
          target: collectionUrl({ spaceUrl, collectionId: 'photos' })
        })
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: mixed
        })
      }
    },
    {
      id: 'did-url-targets.target-other-space-refused',
      name:
        '[delegated] a target that dereferences to another Space is refused ' +
        '(masked not-found)',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { spaceUrl, otherSpaceUrl } = provisioned
        // `/other` maps to a second Space of the same controller.
        const grant = await grantToBob({ ctx, provisioned, path: '/other/' })
        // Refused at the Space the target dereferences to, whose root the
        // chain does not start from.
        await assertBobMasked({
          provisioned,
          url: docUrl(otherSpaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
        // Refused at the Space the root dereferences to as well.
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
      }
    },
    {
      id: 'did-url-targets.target-other-host-refused',
      name:
        '[delegated] a target that dereferences to another host is refused ' +
        '(masked not-found)',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        // `/remote` maps to this Space's path on another host.
        const grant = await grantToBob({ ctx, provisioned, path: '/remote/' })
        await assertBobMasked({
          provisioned,
          url: docUrl(provisioned.spaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
      }
    },
    {
      id: 'did-url-targets.target-above-parent-refused',
      name:
        "[delegated] a target that dereferences above its parent's URL is " +
        'refused (masked not-found)',
      specRefs: [DELEGATION_CHAINS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { bob, did, spaceUrl } = provisioned
        const parent = await grantToBob({ ctx, provisioned })
        // `/photos/up` extends the parent's path, and maps to the Space URL
        // above the `photos` Collection. Were it admitted, Bob would read the
        // `albums` Collection.
        const narrowed = await delegateToBob({
          ctx,
          provisioned,
          signer: bob.signer,
          parent,
          target: `${did}/photos/up/`
        })
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'albums', 'a-1'),
          capability: narrowed
        })
      }
    },
    {
      id: 'did-url-targets.selector-first-link-admitted',
      name:
        '[delegated] a selector the first link introduces dereferences ' +
        'through that document version',
      specRefs: [SELECTORS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { spaceUrl } = provisioned
        // Version 2 maps `/pics` to `photos`. The current version maps it to
        // `albums`.
        const pinned = await grantToBob({
          ctx,
          provisioned,
          path: '/pics/?versionNumber=2'
        })
        const read = await bobGet({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: pinned
        })
        await assertReadFrom(read, 'photos')
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'albums', 'a-1'),
          capability: pinned
        })
      }
    },
    {
      id: 'did-url-targets.selector-later-link-refused',
      name:
        '[delegated] a selector introduced beneath the first link is ' +
        'refused (masked not-found)',
      specRefs: [SELECTORS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { did, spaceUrl } = provisioned
        const unpinned = await grantToBob({ ctx, provisioned, path: '/' })
        const pinned = await bobDelegatesUnchecked({
          ctx,
          provisioned,
          parent: unpinned,
          target: `${did}/pics/?versionNumber=2`
        })
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: pinned
        })
      }
    },
    {
      id: 'did-url-targets.selector-changed-refused',
      name:
        '[delegated] a selector that differs from the parent link is ' +
        'refused (masked not-found)',
      specRefs: [SELECTORS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { did, spaceUrl } = provisioned
        const pinned = await grantToBob({
          ctx,
          provisioned,
          path: '/pics/?versionNumber=3'
        })
        // Version 2 would map the same path to the `photos` Collection.
        const repinned = await bobDelegatesUnchecked({
          ctx,
          provisioned,
          parent: pinned,
          target: `${did}/pics/?versionNumber=2`
        })
        await assertBobMasked({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: repinned
        })
      }
    },
    {
      id: 'did-url-targets.query-request-accepted',
      name:
        '[delegated] a request that adds a query to the dereferenced URL ' +
        'is accepted',
      specRefs: [DELEGATION_CHAINS, SELECTORS],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { spaceUrl } = provisioned
        const listed = await bobGet({
          provisioned,
          url: `${collectionUrl({ spaceUrl, collectionId: 'photos' })}?limit=1`,
          capability: await grantToBob({ ctx, provisioned })
        })
        assert.equal(listed.status, 200)
      }
    },
    {
      id: 'did-url-targets.expired-named-at-own-space-only',
      name:
        '[delegated] an expired DID URL grant is not named as expired at a ' +
        'Space its root does not dereference to',
      specRefs: [DENIAL_CAUSES],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { spaceUrl, otherSpaceUrl } = provisioned
        // Backdating `now` two hours also backdates the default expiry, so
        // the grant expired well past any verifier's clock-skew allowance.
        const expired = await grantToBob({
          ctx,
          provisioned,
          now: Date.now() - 2 * 60 * 60 * 1000
        })
        // At the Space the root dereferences to, the cause may be named. The
        // profile's Errors list also files an expired chain under 400.
        const atOwn = await bobGet({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: expired
        })
        const problem: any = await atOwn.json()
        assert.ok(
          (atOwn.status === 404 &&
            [CAPABILITY_EXPIRED, NOT_FOUND].includes(problem.type)) ||
            (atOwn.status === 400 &&
              problem.type === INVALID_AUTHORIZATION_HEADER),
          `expected 404 capability-expired, 404 not-found or 400 ` +
            `invalid-authorization-header; got ${atOwn.status} ${problem.type}`
        )
        // The second Space shares the controller, so the chain verifies there
        // up to the expiry. Naming it would reveal that the two Spaces share
        // a controller.
        await assertBobMasked({
          provisioned,
          url: docUrl(otherSpaceUrl, 'photos', 'doc-1'),
          capability: expired
        })
      }
    },
    {
      id: 'did-url-targets.revoked-named-at-own-space-only',
      name:
        '[delegated] a revoked DID URL grant is not named as revoked at a ' +
        'Space its root does not dereference to',
      optional: true,
      specRefs: [DENIAL_CAUSES, REVOCATION],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { owner, spaceId, spaceUrl, otherSpaceId, otherSpaceUrl } =
          provisioned
        const grant = await grantToBob({ ctx, provisioned })
        // The Space controller revokes it in both Spaces. A server does not
        // dereference the root of a chain the controller submits, so the
        // second Space accepts it too.
        const pws = ctx.pwsClient({ signer: owner })
        await revokeOrSkip({ ctx, pws, spaceId, capability: grant })
        // The first submission showed that the server has the endpoint, so a
        // refusal at the second Space fails the case.
        await pws.space(otherSpaceId).revoke(grant)
        const atOwn = await bobGet({
          provisioned,
          url: docUrl(spaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
        await assertRefusedAsRevoked(atOwn)
        await assertBobMasked({
          provisioned,
          url: docUrl(otherSpaceUrl, 'photos', 'doc-1'),
          capability: grant
        })
      }
    },
    {
      id: 'did-url-targets.revoked-grant-refused',
      name: '[delegated] a revoked DID URL grant is refused from then on',
      optional: true,
      specRefs: [REVOCATION],
      run: async (ctx, state) => {
        const provisioned = requireProvisioned(ctx, state)
        const { owner, rogue, spaceId, spaceUrl } = provisioned
        const url = docUrl(spaceUrl, 'photos', 'doc-1')
        const grant = await grantToBob({ ctx, provisioned })
        // The grant works before revocation, so the refusal afterward is the
        // revocation.
        const before = await bobGet({ provisioned, url, capability: grant })
        assert.equal(before.status, 200)
        await revokeOrSkip({
          ctx,
          pws: ctx.pwsClient({ signer: owner }),
          spaceId,
          capability: grant
        })
        await assertRefusedAsRevoked(
          await bobGet({ provisioned, url, capability: grant })
        )
        // A caller without the grant's key learns nothing of the revocation.
        const byRogue = await signedRequest({
          url,
          method: 'GET',
          invocationSigner: rogue,
          capability: grant
        })
        await assertMasked({ provisioned, response: byRogue, url })
      }
    }
  ]
}
