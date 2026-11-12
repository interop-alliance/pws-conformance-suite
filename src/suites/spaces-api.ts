/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Spaces Repository and Space API.
 */
import {
  collectionMetaUrl,
  collectionUrl,
  resourceUrl,
  spaceLinksetUrl,
  spaceMetaUrl,
  spacePolicyUrl,
  spacesRepositoryUrl,
  spaceUrlById
} from '@interop/pws-client/paths'

import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { ConformanceContext, Suite } from '../harness/types.js'
import {
  assertResolvesTo,
  checkBackendsMember,
  withoutContainerUrls,
  withoutReplicas,
  withoutWriteStamp
} from '../helpers.js'

interface State {
  alice: any
  aliceDelegatedApp: any
  bob: any
  collectionId: string
  resourceId: string
}

/**
 * The problem `type`s a delegated Create Space whose chain is expired or
 * whose proof fails verification may carry. The core spec ("Create Space
 * Errors") files both under `controller-mismatch`. The authorization
 * profile's Errors list files an expired chain and a proof that fails
 * verification under `invalid-authorization-header`. Both are 400.
 */
const FAILED_CHAIN_TYPES = [
  'https://w3id.org/pws#controller-mismatch',
  'https://w3id.org/pws#invalid-authorization-header'
]

/**
 * Attempts a delegated Create Space naming Alice as the body's `controller`,
 * with the delegation chain built in one of three verification-failure
 * shapes:
 *
 * - `foreign-root`: the chain is rooted in Bob, not the body's controller --
 *   Bob delegates POST /spaces/ to Alice's app, which invokes naming Alice;
 * - `expired`: Alice's delegation to her app is backdated via ezcap's `now`
 *   override, so it expired long before the invocation -- far past any
 *   reasonable verifier clock-skew tolerance;
 * - `tampered-proof`: Alice's delegation is mutated after signing (its
 *   `expires` extended), so the delegation proof no longer verifies.
 *
 * Returns the response status and problem body plus the attempted space id,
 * so callers can also assert the Space was never created.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}   the run context
 * @param options.state {State}   the suite state (supplies the actors)
 * @param options.shape {string}   one of the three failure shapes above
 * @returns {Promise<{ spaceId: string; status?: number; problem?: any }>}
 */
async function attemptDelegatedCreate({
  ctx,
  state,
  shape
}: {
  ctx: ConformanceContext
  state: State
  shape: 'foreign-root' | 'expired' | 'tampered-proof'
}): Promise<{ spaceId: string; status?: number; problem?: any }> {
  const { serverUrl, zcapClient, generateId } = ctx
  const { alice, aliceDelegatedApp, bob } = state
  const spacesUrl = spacesRepositoryUrl({ baseServerUrl: serverUrl })

  let capability: any
  if (shape === 'foreign-root') {
    capability = await bob.rootClient.delegate({
      allowedActions: ['POST'],
      invocationTarget: spacesUrl,
      controller: aliceDelegatedApp.did
    })
  } else if (shape === 'expired') {
    // Backdating `now` two hours also backdates the default `expires`
    // (`now` + 5 minutes), so the delegation expired ~115 minutes ago.
    capability = await alice.rootClient.delegate({
      allowedActions: ['POST'],
      invocationTarget: spacesUrl,
      controller: aliceDelegatedApp.did,
      now: Date.now() - 2 * 60 * 60 * 1000
    })
  } else {
    capability = await alice.rootClient.delegate({
      allowedActions: ['POST'],
      invocationTarget: spacesUrl,
      controller: aliceDelegatedApp.did
    })
    // Extend `expires` (a signed field) after signing: the zcap stays
    // well-formed and unexpired, but its delegation proof no longer verifies.
    capability.expires =
      new Date(Date.parse(capability.expires) + 60 * 60 * 1000)
        .toISOString()
        .slice(0, -5) + 'Z'
  }

  const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })
  const spaceId = generateId()
  let status: number | undefined, problem: any
  try {
    const response = await aliceAppClient.request({
      url: spacesUrl,
      capability,
      method: 'POST',
      action: 'POST',
      json: {
        id: spaceId,
        name: 'Space From A Failing Delegated Create',
        controller: alice.did
      }
    })
    status = response.status
    problem = response.data
  } catch (err: any) {
    status = err.response?.status
    problem = err.data
  }
  return { spaceId, status, problem }
}

/**
 * Collects a problem body's `detail` text wherever the spec allows it to
 * live: the RFC 9457 top-level `detail` member and the `detail` of each
 * `errors` array entry (the placement the spec's canonical examples use).
 *
 * @param problem {any}   a parsed application/problem+json body
 * @returns {string}   the concatenated detail text ('' when none present)
 */
function failureDetail(problem: any): string {
  const entries = Array.isArray(problem?.errors) ? problem.errors : []
  return [problem?.detail, ...entries.map((entry: any) => entry?.detail)]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
}

/**
 * The Space container URL, in its v0.5 canonical (trailing-slash) form: lists
 * Collections (`GET`), adds one (`POST`), and removes the Space (`DELETE`).
 * Built under the server's base server URL (spec "Server Layout").
 *
 * @param serverUrl {string}
 * @param spaceId {string}
 * @returns {string}
 */
function spaceUrl(serverUrl: string, spaceId: string): string {
  return spaceUrlById({ baseServerUrl: serverUrl, spaceId })
}

/**
 * The Space Metadata object URL (spec "Space Metadata Data Model"): where
 * Read Space and Update (or Create by Id) Space now live, since v0.5 moved
 * them off the bare (no-slash) Space URL.
 *
 * @param serverUrl {string}
 * @param spaceId {string}
 * @returns {string}
 */
function spaceMetaUrlById(serverUrl: string, spaceId: string): string {
  return spaceMetaUrl({ spaceUrl: spaceUrl(serverUrl, spaceId) })
}

/**
 * Reads a Space's backends listing (spec "Space Backends Available") as its
 * controller, for comparison with the Metadata object's `backends` member.
 *
 * @param options {object}
 * @param options.alice {object}   the Space controller (carries `pws`)
 * @param options.spaceId {string}
 * @returns {Promise<unknown>}
 */
async function readBackendsListing({
  alice,
  spaceId
}: {
  alice: any
  spaceId: string
}): Promise<unknown> {
  return alice.pws.space(spaceId).backends()
}

/**
 * Reads every page of a list operation as the given client, following each
 * page's `next` link until a page omits it (spec "Pagination"). A server MAY
 * paginate any list, and a short page does not end the list.
 *
 * @param options {object}
 * @param options.client {ZcapClient}   the client to sign each page request
 * @param options.url {string}   the first page's URL
 * @returns {Promise<{ first: any; items: any[] }>}   the first page as served
 *   and the items of every page
 */
async function readAllPages({
  client,
  url
}: {
  client: any
  url: string
}): Promise<{ first: any; items: any[] }> {
  const response = await client.request({ url, method: 'GET' })
  assert.equal(response.status, 200)
  const first = response.data
  assert.ok(Array.isArray(first?.items), 'expected an `items` array')
  const items: any[] = [...first.items]
  const seen = new Set<string>([url])
  let page = first
  let pageUrl = url
  while (typeof page.next === 'string') {
    pageUrl = new URL(page.next, pageUrl).toString()
    assert.ok(!seen.has(pageUrl), `\`next\` revisits ${pageUrl}`)
    seen.add(pageUrl)
    const next = await client.request({ url: pageUrl, method: 'GET' })
    assert.equal(next.status, 200)
    page = next.data
    assert.ok(Array.isArray(page?.items), 'expected an `items` array')
    items.push(...page.items)
  }
  return { first, items }
}

/**
 * Asserts the optional `totalItems` member of a list response, when present.
 * It counts the whole list, not the page (spec "The paginated response").
 * Pages read one after another may see the list change in between, so the
 * count is compared with the item count only when the list came back as a
 * single page.
 *
 * @param options {object}
 * @param options.listing {any}   the first page as served
 * @param options.total {number}   the number of items across every page
 */
function assertTotalItems({
  listing,
  total
}: {
  listing: any
  total: number
}): void {
  if (listing.totalItems === undefined) {
    return
  }
  assert.ok(
    Number.isInteger(listing.totalItems) && listing.totalItems >= 0,
    '`totalItems` must be a non-negative integer'
  )
  if (listing.next === undefined) {
    assert.equal(
      listing.totalItems,
      total,
      '`totalItems` counts the whole list, and this list is one page'
    )
  }
}

/**
 * Sends an unsigned Create Space with a well-formed JSON body naming Alice as
 * the controller. The request lacks only authorization, so the one error that
 * applies is `missing-authorization` (401).
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}   the run context
 * @param options.alice {object}   the actor named as the body's controller
 * @returns {Promise<Response>}
 */
async function postUnauthorizedCreate({
  ctx,
  alice
}: {
  ctx: ConformanceContext
  alice: any
}): Promise<Response> {
  return fetch(spacesRepositoryUrl({ baseServerUrl: ctx.serverUrl }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: ctx.generateId(),
      name: 'Space From An Unauthorized Create',
      controller: alice.did
    })
  })
}

/**
 * Asserts the Space at `spaceId` was never created: its named controller
 * (Alice) could read it if it had been, so her authorized read must 404.
 *
 * @param options {object}
 * @param options.ctx {ConformanceContext}   the run context
 * @param options.alice {object}   the actor named as the body's controller
 * @param options.spaceId {string}   the id the rejected create supplied
 * @returns {Promise<void>}
 */
async function assertSpaceNotCreated({
  ctx,
  alice,
  spaceId
}: {
  ctx: ConformanceContext
  alice: any
  spaceId: string
}): Promise<void> {
  let checkError: any
  try {
    await alice.rootClient.request({
      url: spaceMetaUrlById(ctx.serverUrl, spaceId),
      method: 'GET'
    })
  } catch (err) {
    checkError = err
  }
  assert.ok(checkError, 'the rejected Space must not exist')
  assert.equal(checkError.response.status, 404)
}

export const spacesApi: Suite<State> = {
  id: 'spaces-api',
  name: 'Spaces',

  setup: async ctx => {
    // Shallow-clone the shared actors so per-suite scratch fields (space ids)
    // do not leak into other suites.
    const alice: any = { ...ctx.actors.alice }
    const aliceDelegatedApp: any = { ...ctx.actors.aliceDelegatedApp }
    const bob: any = { ...ctx.actors.bob }
    alice.space1 = { id: ctx.generateId() }
    alice.space2 = { id: ctx.generateId() }
    alice.space3 = { id: ctx.generateId() }
    // Pre-create alice.space1 so tests that need an existing space are not
    // implicitly coupled to the creation test's ordering
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    return { alice, aliceDelegatedApp, bob, collectionId: '', resourceId: '' }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    for (const spaceId of [alice.space1.id, alice.space2.id, alice.space3.id]) {
      try {
        await alice.rootClient.request({
          url: spaceUrl(ctx.serverUrl, spaceId),
          method: 'DELETE'
        })
      } catch {
        /* best-effort cleanup */
      }
    }
  },

  groups: [
    {
      name: 'Collections API',
      setup: async (ctx, state) => {
        const { alice } = state
        state.collectionId = ctx.generateId()
        state.resourceId = ctx.generateId()

        await ctx.createSpace({
          spaceDescription: {
            id: alice.space3.id,
            name: "Alice's Space #3 (Collections Test)",
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const space3Url = spaceUrl(ctx.serverUrl, alice.space3.id)
        await alice.rootClient.request({
          url: collectionMetaUrl({
            spaceUrl: space3Url,
            collectionId: state.collectionId
          }),
          method: 'PUT',
          json: { id: state.collectionId, name: 'Test Collection' }
        })

        await alice.rootClient.request({
          url: resourceUrl({
            spaceUrl: space3Url,
            collectionId: state.collectionId,
            resourceId: state.resourceId
          }),
          method: 'PUT',
          json: { id: state.resourceId, name: 'Test Resource' }
        })
      }
    }
  ],

  tests: [
    {
      id: 'repository.anonymous-list-empty',
      name: 'GET /spaces/ without auth headers returns the empty listing (200)',
      group: 'Spaces Repository API',
      specRefs: ['https://w3id.org/pws#list-spaces-operation'],
      run: async ctx => {
        const { serverUrl } = ctx
        // List Spaces is the spec's exception to 404 masking: an anonymous
        // request is not an error -- it is simply authorized to see no spaces.
        const spacesUrl = spacesRepositoryUrl({ baseServerUrl: serverUrl })
        const response = await fetch(spacesUrl)
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        const listing = (await response.json()) as any
        assertResolvesTo({
          value: listing.url,
          base: spacesUrl,
          expected: spacesUrl,
          label: 'the listing `url`'
        })
        // `totalItems` is OPTIONAL, and counts the whole list when present.
        if (listing.totalItems !== undefined) {
          assert.equal(listing.totalItems, 0)
        }
        assert.deepStrictEqual(listing.items, [])
      }
    },
    {
      id: 'repository.list-scoped-to-controller',
      name: '[root] GET /spaces/ lists only spaces controlled by the requester',
      group: 'Spaces Repository API',
      specRefs: ['https://w3id.org/pws#list-spaces-operation'],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        // A persistent external server may hold any number of spaces for Alice
        // from earlier runs, so assert containment / exclusion, not contents.
        const bobSpaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: bobSpaceId,
            name: "Bob's Listing Space",
            controller: bob.did
          },
          rootClient: bob.rootClient
        })

        try {
          // The listing MAY be paginated, so every page is read before
          // asserting containment or exclusion.
          const spacesUrl = spacesRepositoryUrl({ baseServerUrl: serverUrl })
          const { first: listing, items } = await readAllPages({
            client: alice.rootClient,
            url: spacesUrl
          })
          assertResolvesTo({
            value: listing.url,
            base: spacesUrl,
            expected: spacesUrl,
            label: 'the listing `url`'
          })
          assertTotalItems({ listing, total: items.length })
          const aliceItem = items.find(
            (item: any) => item.id === alice.space1.id
          )
          assert.ok(aliceItem, "Alice's listing includes her pre-created space")
          // A Space is a container, so its listed `url` carries the
          // canonical trailing slash (spec "Space Metadata Data Model").
          assertResolvesTo({
            value: aliceItem.url,
            base: spacesUrl,
            expected: spaceUrl(serverUrl, alice.space1.id),
            label: 'the listed Space `url`'
          })
          assert.ok(
            !items.some((item: any) => item.id === bobSpaceId),
            "Alice's listing must not reveal Bob's space"
          )
        } finally {
          await bob.rootClient.request({
            url: spaceUrl(serverUrl, bobSpaceId),
            method: 'DELETE'
          })
        }
      }
    },
    {
      id: 'repository.create-unauthorized-401',
      name: 'POST /spaces/ should 401 error when no authorization headers',
      group: 'Spaces Repository API',
      specRefs: ['https://w3id.org/pws#create-space-operation'],
      run: async (ctx, state) => {
        // The body and `Content-Type` are well formed, so the missing
        // authorization is the request's only fault. The spec's
        // `application/problem+json` content type is a SHOULD, so it is not
        // asserted (spec "Error Handling").
        const response = await postUnauthorizedCreate({
          ctx,
          alice: state.alice
        })
        assert.equal(response.status, 401)
      }
    },
    {
      id: 'repository.create-missing-controller-400',
      name: 'POST /spaces/ without a "controller" in the body yields invalid-request-body (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createSpace, generateId } = ctx
        const { alice } = state
        // The `controller` requirement applies before any provisioning or
        // capability concern, so this holds on both the onboarding-token and
        // signed-zcap paths. The token path of createSpace() returns the
        // status; the zcap path throws on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: generateId(),
              name: 'Space With No Controller'
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-request-body')
      }
    },
    {
      id: 'repository.create-controller-mismatch-400',
      name: "[root] POST /spaces/ signed by a key that is not the body's controller yields controller-mismatch (400)",
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#controller-mismatch'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice, bob } = state
        if (ctx.onboardingToken) {
          // With an onboarding token configured, the token itself vouches for
          // provisioning (delegated provisioning), so the signer-vs-body
          // consent check under test here is legitimately skipped.
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Create Space is verified against the *body's* controller: Bob signs
        // the invocation but names Alice as controller, with no delegation
        // chain rooted in her -- the direct signer-mismatch shape.
        const spaceId = generateId()
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: spacesRepositoryUrl({ baseServerUrl: serverUrl }),
            method: 'POST',
            action: 'POST',
            json: {
              id: spaceId,
              name: 'Space Bob Claims For Alice',
              controller: alice.did
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the mismatched create to fail')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#controller-mismatch'
        )

        // The Space must not have been created: its named controller (Alice)
        // would be able to read it if it had been.
        let checkError: any
        try {
          await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, spaceId),
            method: 'GET'
          })
        } catch (err) {
          checkError = err
        }
        assert.ok(checkError, 'the rejected Space must not exist')
        assert.equal(checkError.response.status, 404)
      }
    },
    {
      id: 'repository.create-invalid-id-400',
      name: 'POST /spaces/ with a non-URL-safe space id yields invalid-id (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#identifiers',
        'https://w3id.org/pws#invalid-id'
      ],
      run: async (ctx, state) => {
        const { createSpace } = ctx
        const { alice } = state
        // The id is carried in the request body (not the URL), so it reaches
        // id validation rather than being reshaped by routing. A space
        // character is outside the RFC 3986 unreserved set, so the id is not
        // URL-safe (spec: Identifier Required Properties). Rejection precedes
        // any provisioning concern, so this holds on both the onboarding-token
        // and signed-zcap paths: the token path of createSpace() returns the
        // status; the zcap path throws on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: 'a b',
              name: 'Space With An Unsafe Id',
              controller: alice.did
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-id')
      }
    },
    {
      id: 'repository.create-controller-not-did-400',
      name: 'POST /spaces/ whose body controller is not a DID is rejected (400 invalid-request-body)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createSpace, generateId } = ctx
        const { alice } = state
        // A `controller` that is present but not a DID (here an https URL) is a
        // malformed request body -- rejected before any provisioning concern,
        // so this holds on both the onboarding-token and signed-zcap paths. The
        // token path of createSpace() returns the status; the zcap path throws
        // on non-2xx -- capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: generateId(),
              name: 'Space With A Non-DID Controller',
              controller: 'https://example.com/alice'
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-request-body')
      }
    },
    {
      id: 'repository.create-controller-unsupported-did-method-400',
      name: 'POST /spaces/ whose body controller is a DID of an unregistered method is rejected (400 invalid-request-body)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#space-controller-did-method-registry',
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { createSpace, generateId } = ctx
        const { alice } = state
        // A syntactically valid DID whose method is not in the Space Controller
        // DID Method Registry (did:key is REQUIRED, did:webvh OPTIONAL; nothing
        // else is registered). A server refuses an unsupported method with
        // invalid-request-body, as it does a non-DID controller -- distinct
        // from controller-mismatch, which presumes a resolvable controller.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: generateId(),
              name: 'Space With An Unsupported DID Method Controller',
              controller: 'did:web:example.com:alice'
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://w3id.org/pws#invalid-request-body')
      }
    },
    {
      id: 'repository.create-delegated-201',
      name: "[delegated] a provisioning app creates a Space on Alice's behalf via POST (201)",
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-operation',
        'https://w3id.org/pws#was-authorization-profile-v0-1'
      ],
      run: async (ctx, state) => {
        const { serverUrl, zcapClient, generateId } = ctx
        const { alice, aliceDelegatedApp } = state
        if (ctx.onboardingToken) {
          // With an onboarding token configured, the token vouches for
          // provisioning, so the delegated-consent path under test here is
          // legitimately bypassed.
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Alice delegates a POST /spaces/ capability to her app; the app
        // invokes it, naming Alice as the controller. The invocation is
        // authorized by a delegation chain rooted in the body's controller, so
        // the create succeeds and Alice controls the Space from the start
        // (delegated provisioning).
        const spacesUrl = spacesRepositoryUrl({ baseServerUrl: serverUrl })
        const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })
        const provisioningCapability = await alice.rootClient.delegate({
          allowedActions: ['POST'],
          invocationTarget: spacesUrl,
          controller: aliceDelegatedApp.did
        })

        const spaceId = generateId()
        try {
          const response = await aliceAppClient.request({
            url: spacesUrl,
            capability: provisioningCapability,
            method: 'POST',
            action: 'POST',
            json: {
              id: spaceId,
              name: 'Provisioned for Alice',
              controller: alice.did
            }
          })
          assert.equal(response.status, 201)
          assert.equal((response.data as any).controller, alice.did)

          // The Space exists and is controlled by Alice: her root key reads it.
          const checkResponse = await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, spaceId),
            method: 'GET',
            action: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.controller, alice.did)
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'repository.create-delegated-foreign-root-400',
      name: "[delegated] POST /spaces/ via a chain rooted in a DID other than the body's controller yields controller-mismatch (400)",
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#controller-mismatch'
      ],
      run: async (ctx, state) => {
        if (ctx.onboardingToken) {
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Bob (not the body's controller) delegates POST /spaces/ to Alice's
        // app, which invokes naming Alice as controller: the chain itself is
        // internally consistent but rooted in the wrong DID, so Alice never
        // consented to the create.
        const { spaceId, status, problem } = await attemptDelegatedCreate({
          ctx,
          state,
          shape: 'foreign-root'
        })
        assert.equal(status, 400)
        assert.equal(problem.type, 'https://w3id.org/pws#controller-mismatch')
        await assertSpaceNotCreated({ ctx, alice: state.alice, spaceId })
      }
    },
    {
      id: 'repository.create-delegated-expired-400',
      name: '[delegated] POST /spaces/ via an expired delegation yields controller-mismatch or invalid-authorization-header (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#controller-mismatch',
        'https://w3id.org/pws#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        if (ctx.onboardingToken) {
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Alice's delegation to her app is genuine but expired (its proof is
        // backdated two hours, past any clock-skew tolerance). The core spec
        // files this under controller-mismatch. The authorization profile
        // files an expired chain under invalid-authorization-header. Either
        // is accepted.
        const { spaceId, status, problem } = await attemptDelegatedCreate({
          ctx,
          state,
          shape: 'expired'
        })
        assert.equal(status, 400)
        assert.ok(
          FAILED_CHAIN_TYPES.includes(problem?.type),
          `unexpected problem type ${problem?.type}`
        )
        await assertSpaceNotCreated({ ctx, alice: state.alice, spaceId })
      }
    },
    {
      id: 'repository.create-delegated-tampered-400',
      name: '[delegated] POST /spaces/ via a delegation whose proof fails verification yields controller-mismatch or invalid-authorization-header (400)',
      group: 'Spaces Repository API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#controller-mismatch',
        'https://w3id.org/pws#invalid-authorization-header'
      ],
      run: async (ctx, state) => {
        if (ctx.onboardingToken) {
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // Alice's delegation is mutated after signing, so everything lines up
        // statically (right root, right signer, unexpired) but the delegation
        // proof fails signature verification. As with an expired chain, the
        // core spec and the authorization profile name different types, and
        // either is accepted.
        const { spaceId, status, problem } = await attemptDelegatedCreate({
          ctx,
          state,
          shape: 'tampered-proof'
        })
        assert.equal(status, 400)
        assert.ok(
          FAILED_CHAIN_TYPES.includes(problem?.type),
          `unexpected problem type ${problem?.type}`
        )
        await assertSpaceNotCreated({ ctx, alice: state.alice, spaceId })
      }
    },
    {
      id: 'repository.create-delegated-details-distinct',
      name: '[delegated] the three delegated-create failure causes carry pairwise-distinct detail strings',
      group: 'Spaces Repository API',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#controller-mismatch'
      ],
      run: async (ctx, state) => {
        if (ctx.onboardingToken) {
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // The spec SHOULD: differentiate the failure cause in the
        // non-normative `detail` (top-level or in the `errors` array --
        // placement is not constrained). Nothing is asserted about wording,
        // only that the three shapes yield three different non-empty strings.
        // Distinctness is a signal, not proof: per-request echo content in
        // `detail` could mask an undifferentiated implementation.
        const shapes = ['foreign-root', 'expired', 'tampered-proof'] as const
        const details: string[] = []
        for (const shape of shapes) {
          const { status, problem } = await attemptDelegatedCreate({
            ctx,
            state,
            shape
          })
          assert.equal(status, 400, `expected the ${shape} create to fail`)
          const detail = failureDetail(problem)
          assert.ok(
            detail.length > 0,
            `expected a non-empty detail on the ${shape} failure`
          )
          details.push(detail)
        }
        assert.equal(
          new Set(details).size,
          shapes.length,
          'expected the three failure causes to be differentiated in detail'
        )
      }
    },
    {
      id: 'repository.error-body-type-and-title',
      name: 'an error response carries both a non-empty `type` and a non-empty `title`',
      group: 'Spaces Repository API',
      specRefs: ['https://w3id.org/pws#error-handling'],
      run: async (ctx, state) => {
        // An unauthenticated Create Space with a well-formed body fails only
        // for its missing authorization (401). The spec makes `type` and
        // `title` REQUIRED members of every error body. The
        // `application/problem+json` content type is a SHOULD, so it is not
        // asserted (spec "Error Handling").
        const response = await postUnauthorizedCreate({
          ctx,
          alice: state.alice
        })
        assert.equal(response.status, 401)
        const problem = (await response.json()) as {
          type?: unknown
          title?: unknown
        }
        assert.equal(typeof problem.type, 'string')
        assert.ok(
          (problem.type as string).length > 0,
          'error `type` must be non-empty'
        )
        assert.equal(typeof problem.title, 'string')
        assert.ok(
          (problem.title as string).length > 0,
          'error `title` must be non-empty'
        )
      }
    },
    {
      id: 'space.create-post',
      name: '[root] create space via POST',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#create-space-operation'],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId, withoutCreatedBy } = ctx
        const { alice } = state
        const freshSpaceId = generateId()
        const spaceDescription = {
          id: freshSpaceId,
          name: 'Conformance Test Space',
          controller: alice.did
        }
        const response = await createSpace({
          spaceDescription,
          rootClient: alice.rootClient
        })
        assert.equal(response.status, 201)
        const rest = await checkBackendsMember({
          serverUrl,
          metadata: response.data,
          readListing: () =>
            readBackendsListing({ alice, spaceId: freshSpaceId })
        })
        // The container `url` is the canonical trailing-slash form (spec
        // "Space Metadata Data Model"), resolved against the request URL so
        // a server under a base path compares correctly. The echo carries the
        // write stamp (`updatedAt`, `updatedAtCounter`, `originId`).
        const freshSpaceUrl = spaceUrl(serverUrl, freshSpaceId)
        assert.deepStrictEqual(
          withoutCreatedBy(
            withoutReplicas(
              withoutWriteStamp(
                withoutContainerUrls({
                  value: rest,
                  base: spacesRepositoryUrl({ baseServerUrl: serverUrl }),
                  containerUrl: freshSpaceUrl,
                  linksetUrl: spaceLinksetUrl({ spaceUrl: freshSpaceUrl })
                })
              )
            )
          ),
          {
            id: freshSpaceId,
            name: 'Conformance Test Space',
            type: ['Space'],
            controller: alice.did
          }
        )
        assert.match(response.headers.get('content-type')!, /application\/json/)
        // The spec requires the new Space's absolute URL here (spec "Create
        // Space operation"), and the layout puts it at `{base}space/{id}/`.
        assert.equal(response.headers.get('location'), freshSpaceUrl)

        // Clean up the space created by this test
        await alice.rootClient.request({
          url: spaceUrl(serverUrl, freshSpaceId),
          method: 'DELETE'
        })
      }
    },
    {
      id: 'space.create-post-id-conflict-409',
      name: '[root] POST /spaces/ with an existing id yields id-conflict (409)',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#id-conflict'],
      run: async (ctx, state) => {
        const { createSpace } = ctx
        const { alice } = state
        // alice.space1 was pre-created in before(). The onboarding-token path of
        // createSpace() returns the status; the zcap path throws on non-2xx --
        // capture either shape.
        let status: number | undefined, problem: any
        try {
          const response = await createSpace({
            spaceDescription: {
              id: alice.space1.id,
              name: 'Duplicate Space',
              controller: alice.did
            },
            rootClient: alice.rootClient
          })
          status = response.status
          problem = response.data
        } catch (err: any) {
          status = err.response?.status
          problem = err.data
        }
        assert.equal(status, 409)
        assert.equal(problem.type, 'https://w3id.org/pws#id-conflict')
      }
    },
    {
      id: 'space.create-put',
      name: '[root] create space by id via PUT of its Space Metadata object',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#update-or-create-by-id-space-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        const spaceDescription = {
          id: alice.space2.id,
          name: "Alice's Space #2 (School)",
          controller: alice.did
        }
        // The `Location` names the Space container, not the Metadata object
        // that was written (spec "Update (or Create by Id) Space Operation").
        // A server that gates provisioning gates this create too, so it
        // carries the onboarding token when one is configured.
        const response = await ctx.createSpaceByPut({
          spaceId: alice.space2.id,
          spaceDescription,
          rootClient: alice.rootClient
        })

        assert.equal(response.status, 201)
        // Only the spec's example shows a `Location` on this create, so it is
        // checked when present. It is resolved against the request URL.
        const location = response.headers.get('location')
        if (location !== null) {
          assertResolvesTo({
            value: location,
            base: spaceMetaUrlById(serverUrl, alice.space2.id),
            expected: spaceUrl(serverUrl, alice.space2.id),
            label: 'the `Location` header'
          })
        }

        const checkResponse = await alice.rootClient.request({
          url: spaceMetaUrlById(serverUrl, alice.space2.id),
          method: 'GET'
        })
        assert.equal(checkResponse.status, 200)
      }
    },
    {
      id: 'space.update-controller-swap-404',
      name: "[root] a PUT swapping 'controller', signed by the would-be new controller, yields 404 and does not transfer the Space",
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-space-operation',
        'https://w3id.org/pws#not-found'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        // An update MUST be verified against the *stored* controller, not the
        // body's proposed one -- otherwise any caller could seize an existing
        // Space by PUTting its id with themselves as controller. Bob attempts
        // exactly that takeover; as an unauthorized write to an existing
        // Space, it gets the privacy-merged not-found (404) mask.
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Escalation Target Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const metaUrl = spaceMetaUrlById(serverUrl, spaceId)
        try {
          let expectedError: any
          try {
            await bob.rootClient.request({
              url: metaUrl,
              method: 'PUT',
              action: 'PUT',
              json: {
                id: spaceId,
                name: 'Seized Space',
                controller: bob.did
              }
            })
          } catch (err) {
            expectedError = err
          }
          assert.ok(expectedError, 'expected the takeover PUT to fail')
          assert.equal(expectedError.response.status, 404)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#not-found'
          )

          // The operation must not have been performed: Alice still controls
          // the Space, name and controller unchanged.
          const checkResponse = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.controller, alice.did)
          assert.equal(checkResponse.data.name, 'Escalation Target Space')
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.update-controller-unsupported-did-method-400',
      name: "[root] a PUT changing 'controller' to a DID of an unregistered method yields invalid-request-body (400) and leaves the Space unchanged",
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#space-controller-did-method-registry',
        'https://w3id.org/pws#setting-a-controller-to-optional-did-method',
        'https://w3id.org/pws#update-or-create-by-id-space-operation',
        'https://w3id.org/pws#invalid-request-body'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        // The stored controller (Alice, a did:key) is authorized to update the
        // Space, so authorization passes; the proposed controller is then
        // refused on its DID method alone (did:web is not registered). The
        // refusal is the same invalid-request-body a create gets, and the
        // stored controller must be untouched -- an accepted-but-unresolvable
        // controller would leave the Space with no party able to act on it.
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Promotion Target Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const metaUrl = spaceMetaUrlById(serverUrl, spaceId)
        try {
          let expectedError: any
          try {
            await alice.rootClient.request({
              url: metaUrl,
              method: 'PUT',
              action: 'PUT',
              json: {
                id: spaceId,
                name: 'Promotion Target Space',
                controller: 'did:web:example.com:alice'
              }
            })
          } catch (err) {
            expectedError = err
          }
          assert.ok(
            expectedError,
            'expected the unsupported-method PUT to fail'
          )
          assert.equal(expectedError.response.status, 400)
          assert.equal(
            expectedError.data.type,
            'https://w3id.org/pws#invalid-request-body'
          )

          const checkResponse = await alice.rootClient.request({
            url: metaUrl,
            method: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.controller, alice.did)
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.anonymous-read-404',
      name: 'GET /space/:spaceId/meta with no auth headers falls through to policy and 404s (no public policy)',
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#read-space-operation',
        'https://w3id.org/pws#read-space-errors'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // Reads no longer 401 at the hook: an anonymous read is allowed to
        // attempt, and is denied as 404 (no-leak) when no policy grants it.
        const response = await fetch(
          spaceMetaUrlById(serverUrl, alice.space1.id),
          {
            method: 'GET'
          }
        )
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'space.noncanonical-redirect-308',
      name: '[root] the non-canonical Space URL 308s to the canonical trailing-slash form; the canonical form is not redirected',
      group: 'Space API',
      optional: true,
      specRefs: ['https://w3id.org/pws#reading-this-document'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The non-canonical form is the canonical Space URL without its
        // trailing slash.
        const canonicalUrl = spaceUrl(serverUrl, alice.space1.id)
        const bareUrl = canonicalUrl.slice(0, -1)
        // Asserted for more than one method, so a server that serves both
        // forms without redirecting does not pass by accident.
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(bareUrl, { method, redirect: 'manual' })
          assert.equal(
            response.status,
            308,
            `expected a 308 for ${method} on the non-canonical Space URL`
          )
          // `Location` may be relative, so it is resolved against the
          // request URL before the comparison.
          assertResolvesTo({
            value: response.headers.get('location'),
            base: bareUrl,
            expected: canonicalUrl,
            label: 'the redirect `Location`'
          })
        }
        // The canonical form itself is not redirected.
        const canonicalResponse = await fetch(canonicalUrl, {
          method: 'GET',
          redirect: 'manual'
        })
        assert.notEqual(canonicalResponse.status, 308)
      }
    },
    {
      id: 'space.put-container-405',
      name: '[root] PUT /space/:spaceId/ (the container URL) is refused with 405 and an Allow header that excludes PUT',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#space-metadata-data-model'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceUrl(serverUrl, alice.space1.id),
            method: 'PUT',
            action: 'PUT',
            json: { name: 'Attempted Container Replacement' }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(
          expectedError,
          'expected a PUT at the Space container URL to be refused'
        )
        assert.equal(expectedError.response.status, 405)
        const allow = (expectedError.response.headers.get('allow') ?? '')
          .split(',')
          .map((method: string) => method.trim())
          .filter(Boolean)
        assert.ok(allow.length > 0, 'expected a non-empty Allow header')
        assert.ok(
          !allow.includes('PUT'),
          'the Allow header must not include PUT: a container is described ' +
            'at its "meta" sub-resource'
        )
      }
    },
    {
      id: 'space.read-missing-404',
      name: 'GET /space/:spaceId/meta should 404 error on not found space id',
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#read-space-operation',
        'https://w3id.org/pws#read-space-errors'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        let expectedError: any
        try {
          await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, 'space-id-that-does-not-exist'),
            method: 'GET',
            action: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        assert.equal(expectedError.response.status, 404)
      }
    },
    {
      id: 'space.read-authorized',
      name: '[root] read the Space Metadata object via GET with proper authorization',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#read-space-operation'],
      run: async (ctx, state) => {
        const { serverUrl, withoutCreatedBy } = ctx
        const { alice } = state
        const response = await alice.rootClient.request({
          url: spaceMetaUrlById(serverUrl, alice.space1.id),
          method: 'GET',
          action: 'GET'
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /application\/json/)
        const rest = await checkBackendsMember({
          serverUrl,
          metadata: response.data,
          readListing: () =>
            readBackendsListing({ alice, spaceId: alice.space1.id })
        })
        assert.deepStrictEqual(
          withoutCreatedBy(
            withoutReplicas(
              withoutWriteStamp(
                withoutContainerUrls({
                  value: rest,
                  base: spaceMetaUrlById(serverUrl, alice.space1.id),
                  containerUrl: spaceUrl(serverUrl, alice.space1.id),
                  linksetUrl: spaceLinksetUrl({
                    spaceUrl: spaceUrl(serverUrl, alice.space1.id)
                  })
                })
              )
            )
          ),
          {
            id: alice.space1.id,
            name: "Alice's Space #1 (Home)",
            type: ['Space'],
            controller: alice.did
          }
        )
      }
    },
    {
      id: 'space.read-delegated',
      name: '[delegated] authorized app should GET /space/:spaceId/meta',
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#read-space-operation',
        'https://w3id.org/pws#was-authorization-profile-v0-1'
      ],
      run: async (ctx, state) => {
        const { serverUrl, zcapClient, withoutCreatedBy } = ctx
        const { alice, aliceDelegatedApp } = state
        const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })

        // A capability delegated on the Space container covers its `meta`
        // sub-resource too (spec "Reading This Document"; ARCHITECTURE.md's
        // v0.5 subtree-attenuation note).
        const delegatedSpaceCapability = await alice.rootClient.delegate({
          allowedActions: ['GET'],
          invocationTarget: spaceUrl(serverUrl, alice.space1.id),
          controller: aliceDelegatedApp.did
        })

        const appResponse = await aliceAppClient.request({
          url: spaceMetaUrlById(serverUrl, alice.space1.id),
          capability: delegatedSpaceCapability,
          method: 'GET',
          action: 'GET'
        })
        assert.equal(appResponse.status, 200)
        assert.match(
          appResponse.headers.get('content-type')!,
          /application\/json/
        )
        const rest = await checkBackendsMember({
          serverUrl,
          metadata: appResponse.data,
          readListing: () =>
            readBackendsListing({ alice, spaceId: alice.space1.id })
        })
        assert.deepStrictEqual(
          withoutCreatedBy(
            withoutReplicas(
              withoutWriteStamp(
                withoutContainerUrls({
                  value: rest,
                  base: spaceMetaUrlById(serverUrl, alice.space1.id),
                  containerUrl: spaceUrl(serverUrl, alice.space1.id),
                  linksetUrl: spaceLinksetUrl({
                    spaceUrl: spaceUrl(serverUrl, alice.space1.id)
                  })
                })
              )
            )
          ),
          {
            id: alice.space1.id,
            name: "Alice's Space #1 (Home)",
            type: ['Space'],
            controller: alice.did
          }
        )
      }
    },
    {
      id: 'space.cross-user-read-404',
      name: "[root] Bob should not be able to GET Alice's Space Metadata object",
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#read-space-operation',
        'https://w3id.org/pws#read-space-errors'
      ],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, bob } = state
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: spaceMetaUrlById(serverUrl, alice.space1.id),
            method: 'GET',
            action: 'GET'
          })
        } catch (err) {
          expectedError = err
        }
        // Bob gets a 404 instead of a 403 to avoid revealing the space's existence
        assert.equal(expectedError.response.status, 404)
      }
    },
    {
      id: 'space.delete',
      name: '[root] Alice should be able to DELETE her provisioned space',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#delete-space-operation'],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Space to Delete',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })

        const deleteResponse = await alice.rootClient.request({
          url: spaceUrl(serverUrl, spaceId),
          method: 'DELETE'
        })
        assert.equal(deleteResponse.status, 204)

        let checkResponse: any
        try {
          await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, spaceId),
            method: 'GET'
          })
        } catch (err: any) {
          checkResponse = err.response
        }
        assert.equal(checkResponse.status, 404)
      }
    },
    {
      id: 'space.create-post-conflict-preserves-original',
      name: '[root] a conflicting POST leaves the original Space untouched (409)',
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#create-space-errors',
        'https://w3id.org/pws#id-conflict'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice, bob } = state
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Original Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        try {
          // POST the same id again as Bob, proposing himself as controller and
          // signing for that consent -- so the invocation clears
          // controller-mismatch and the existence check, which now runs only
          // after that consent check, is what is under test. Create-or-replace
          // by id is PUT's job, so a consenting create at a taken id is still a
          // 409 id-conflict; the token path of createSpace() returns the
          // status; the zcap path throws on non-2xx -- capture either shape.
          let status: number | undefined, problem: any
          try {
            const response = await createSpace({
              spaceDescription: {
                id: spaceId,
                name: 'Usurping Space',
                controller: bob.did
              },
              rootClient: bob.rootClient
            })
            status = response.status
            problem = response.data
          } catch (err: any) {
            status = err.response?.status
            problem = err.data
          }
          assert.equal(status, 409)
          assert.equal(problem.type, 'https://w3id.org/pws#id-conflict')

          // The original Space is untouched: its name and controller are as
          // first created, not Bob's usurping proposal.
          const checkResponse = await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, spaceId),
            method: 'GET',
            action: 'GET'
          })
          assert.equal(checkResponse.status, 200)
          assert.equal(checkResponse.data.name, 'Original Space')
          assert.equal(checkResponse.data.controller, alice.did)
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.create-ignores-body-createdby',
      name: '[root] a body-supplied `createdBy` is ignored by the server',
      group: 'Space API',
      specRefs: ['https://w3id.org/pws#space-metadata-data-model'],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        // `createdBy` is server-managed and read-only: the spec requires a
        // server to ignore a `createdBy` supplied in a request body. The value
        // below is a well-formed but bogus DID that is not the creator.
        const bogusCreatedBy =
          'did:key:z6MkpBMbMaRSv5nsgifRAwEKvHHoiKDMhiAHShTFNmkJXXXX'
        const spaceId = generateId()
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Space With A Bogus createdBy',
            controller: alice.did,
            createdBy: bogusCreatedBy
          },
          rootClient: alice.rootClient
        })
        try {
          const response = await alice.rootClient.request({
            url: spaceMetaUrlById(serverUrl, spaceId),
            method: 'GET',
            action: 'GET'
          })
          assert.equal(response.status, 200)
          // Either absent (token-provisioned create records no createdBy) or
          // set to the real invoker -- never the bogus body value.
          assert.notEqual(
            response.data.createdBy,
            bogusCreatedBy,
            'the server must ignore a body-supplied createdBy'
          )
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'space.create-put-controller-mismatch-400',
      name: '[root] PUT-creating a new Space, signed by someone other than the body controller, yields controller-mismatch (400)',
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#update-or-create-by-id-space-operation',
        'https://w3id.org/pws#controller-mismatch'
      ],
      run: async (ctx, state) => {
        const { serverUrl, generateId } = ctx
        const { alice, bob } = state
        if (ctx.onboardingToken) {
          // With an onboarding token configured, the token itself vouches for
          // provisioning by PUT as well, so the signer-vs-body consent check
          // under test here is legitimately skipped.
          ctx.skip(
            'onboarding token configured: token vouches for provisioning'
          )
        }
        // The create branch of PUT is authorized by the *body's* controller,
        // just like Create Space via POST. Bob signs a PUT that would create a
        // new Space naming Alice as controller, with no delegation chain rooted
        // in her -- the direct signer-mismatch shape (this is the CREATE
        // branch; the update branch is covered by space.update-controller-swap).
        const spaceId = generateId()
        const metaUrl = spaceMetaUrlById(serverUrl, spaceId)
        let expectedError: any
        try {
          await bob.rootClient.request({
            url: metaUrl,
            method: 'PUT',
            action: 'PUT',
            json: {
              id: spaceId,
              name: 'Consentless Space',
              controller: alice.did
            }
          })
        } catch (err) {
          expectedError = err
        }
        assert.ok(expectedError, 'expected the unconsented PUT-create to fail')
        assert.equal(expectedError.response.status, 400)
        assert.equal(
          expectedError.data.type,
          'https://w3id.org/pws#controller-mismatch'
        )

        // The Space must not have been created: its named controller (Alice)
        // would be able to read it if it had been.
        let checkError: any
        try {
          await alice.rootClient.request({
            url: metaUrl,
            method: 'GET',
            action: 'GET'
          })
        } catch (err) {
          checkError = err
        }
        assert.ok(checkError, 'the rejected Space must not exist')
        assert.equal(checkError.response.status, 404)
      }
    },
    {
      id: 'space.reserved-policy-segment',
      name: "[root] GET /space/:spaceId/policy is served as the policy endpoint, not a collection named 'policy'",
      group: 'Space API',
      specRefs: [
        'https://w3id.org/pws#reserved-path-segment-registry',
        'https://w3id.org/pws#space-level-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { serverUrl, createSpace, generateId } = ctx
        const { alice } = state
        // The policy resource is an OPTIONAL extension, advertised by the
        // `policy` feature token (spec "Scope and Conformance Profiles").
        const features = await serviceFeatures({ serverUrl })
        if (!features.includes('policy')) {
          ctx.skip('the service description does not advertise policy')
        }
        const spaceId = generateId()
        // The reserved `policy` segment, resolved beneath the Space URL.
        const policyUrl = spacePolicyUrl({
          spaceUrl: spaceUrl(serverUrl, spaceId)
        })
        await createSpace({
          spaceDescription: {
            id: spaceId,
            name: 'Reserved Segment Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        try {
          // `policy` is a reserved space-level segment: it addresses the
          // access-control policy resource, and MUST NOT be repurposed as a
          // Collection id. Set a policy, then read it back through the same
          // segment to confirm it is served as the policy endpoint.
          await alice.rootClient.request({
            url: policyUrl,
            method: 'PUT',
            action: 'PUT',
            json: { type: 'PublicCanRead' }
          })
          const response = await alice.rootClient.request({
            url: policyUrl,
            method: 'GET',
            action: 'GET'
          })
          assert.equal(response.status, 200)
          // The response is a policy document -- it carries the policy `type`
          // we stored -- not a Collection listing (which would carry `items`).
          assert.equal(response.data.type, 'PublicCanRead')
          assert.equal(
            response.data.items,
            undefined,
            'the policy endpoint must not return a Collection listing'
          )
        } finally {
          try {
            await alice.rootClient.request({
              url: spaceUrl(serverUrl, spaceId),
              method: 'DELETE'
            })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    },
    {
      id: 'collections.list-for-space',
      name: '[root] GET /space/:spaceId/ lists collections for a space',
      group: 'Collections API',
      specRefs: ['https://w3id.org/pws#list-all-collections-operation'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice, collectionId } = state

        // v0.5 moved listing (and creating) Collections onto the Space
        // container URL itself; the retired `collections` sub-resource is
        // covered separately (see `space.retired-collections-redirect`).
        // The listing MAY be paginated, so every page is read.
        const space3Url = spaceUrl(serverUrl, alice.space3.id)
        const { first: listing, items } = await readAllPages({
          client: alice.rootClient,
          url: space3Url
        })
        assertResolvesTo({
          value: listing.url,
          base: space3Url,
          expected: space3Url,
          label: 'the listing `url`'
        })
        assertTotalItems({ listing, total: items.length })
        // A server MAY additionally surface a `public` boolean on each item;
        // when it does, it MUST appear on every item, and a Collection with
        // no PublicCanRead policy attached MUST report `false`.
        const surfacesPublic = items.some(item => 'public' in item)
        const coreItems = items.map(item => {
          const { public: isPublic, url, ...core } = item
          if (surfacesPublic) {
            assert.strictEqual(
              isPublic,
              false,
              'a server that surfaces `public` must report it on every ' +
                'item, and `false` for a Collection with no policy attached'
            )
          }
          // A Collection is a container, so its `url` carries the canonical
          // trailing slash. It is resolved against the listing URL.
          assertResolvesTo({
            value: url,
            base: space3Url,
            expected: collectionUrl({ spaceUrl: space3Url, collectionId }),
            label: 'the listed Collection `url`'
          })
          return core
        })
        assert.deepStrictEqual(coreItems, [
          { id: collectionId, name: 'Test Collection' }
        ])
      }
    },
    {
      id: 'space.retired-collections-redirect',
      name: '[root] GET /space/:spaceId/collections/ (retired in v0.5) MAY 308 to the Space URL',
      group: 'Collections API',
      optional: true,
      specRefs: ['https://w3id.org/pws#space-level-reserved-endpoints'],
      run: async (ctx, state) => {
        const { serverUrl } = ctx
        const { alice } = state
        // The retired `collections` segment, resolved beneath the Space URL.
        const space3Url = spaceUrl(serverUrl, alice.space3.id)
        const retiredUrl = new URL('collections/', space3Url).toString()
        const response = await fetch(retiredUrl, {
          method: 'GET',
          redirect: 'manual'
        })
        if (response.status !== 308) {
          ctx.skip(
            'the retired `collections` endpoint is a MAY 308; this server ' +
              `answered ${response.status} instead`
          )
        }
        // `Location` may be relative, so it is resolved against the request
        // URL before the comparison.
        assertResolvesTo({
          value: response.headers.get('location'),
          base: retiredUrl,
          expected: space3Url,
          label: 'the redirect `Location`'
        })
      }
    }
  ]
}
