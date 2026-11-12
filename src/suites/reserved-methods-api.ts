/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Methods at Reserved Endpoints (spec "Methods at
 * Reserved Endpoints").
 *
 * A request to a reserved endpoint (see the spec's three Reserved Path
 * Segment Registry tables) with a method the server does not implement there
 * MUST be answered `405 Method Not Allowed`, with an `Allow` header naming
 * the methods it does implement. A problem body is optional. Where a server
 * sends one, its type is `about:blank`. An endpoint whose whole feature
 * group is an OPTIONAL extension the server does not implement at all is
 * instead
 * governed by that group's own rule -- typically `unsupported-operation`
 * (501) -- so most cases here accept a 501 in place of the 405. Every case
 * is still required, since either answer is spec-conformant and any other
 * answer is not. A method this specification never assigns an operation to
 * anywhere (`PATCH`), and the container-URL `PUT` refusal, carry no 501
 * escape.
 *
 * Every request is a signed root invocation by Alice: several reserved
 * endpoints require authorization for unsafe methods before the refusal is
 * ever reached (`requireAuthHeadersOrPublicRead` lets only safe methods
 * through unauthenticated), so signing throughout keeps every case on the
 * same footing. Raw `signCapabilityInvocation` + `fetch` is used instead of
 * the high-level `ZcapClient.request()` so arbitrary methods (`PATCH`,
 * `HEAD`) and bodyless success responses can be inspected directly, without
 * the high-level client's success-body JSON parsing or its throw-on-4xx/5xx
 * behavior getting in the way. Each invocation names the request method as
 * its action, except a `HEAD`, which names the `GET` action.
 */
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import {
  collectionBackendUrl,
  collectionLinksetUrl,
  collectionLogUrl,
  collectionMetaUrl,
  collectionPolicyUrl,
  collectionQuotaUrl,
  collectionUrl,
  resourceChunksUrl,
  resourceMetaUrl,
  resourcePolicyUrl,
  resourceUrl,
  spaceBackendsUrl,
  spaceExportUrl,
  spaceImportUrl,
  spaceLinksetUrl,
  spaceMetaUrl,
  spacePolicyUrl,
  spaceQuotasUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import type { ISigner } from '@interop/data-integrity-core'
import { capabilityActionFor } from '../helpers.js'
import assert from '../harness/assert.js'
import type { Suite, TestCase } from '../harness/types.js'

interface State {
  alice: any
  collectionId: string
  resourceId: string
}

/**
 * Signs a raw capability invocation for an arbitrary method and sends it via
 * `fetch`, returning the response untouched.
 *
 * @param options {object}
 * @param options.url {string}   the target URL
 * @param options.method {string}   the HTTP method to send
 * @param options.invocationSigner {ISigner}   the caller's signer
 * @param [options.json] {object}   an optional JSON body
 * @returns {Promise<Response>}
 */
async function signedRequest({
  url,
  method,
  invocationSigner,
  json
}: {
  url: string
  method: string
  invocationSigner: ISigner
  json?: object
}): Promise<Response> {
  const body =
    json === undefined
      ? undefined
      : new TextEncoder().encode(JSON.stringify(json))
  const signatureHeaders = await signCapabilityInvocation({
    url,
    method,
    headers: {
      date: new Date().toUTCString(),
      ...(body !== undefined && { 'content-type': 'application/json' })
    },
    ...(body !== undefined && { body }),
    invocationSigner,
    // A HEAD names the `GET` action. Every other method names itself.
    capabilityAction: capabilityActionFor(method)
  })
  return fetch(url, {
    method,
    headers: signatureHeaders as Record<string, string>,
    ...(body !== undefined && { body: new Blob([body]) })
  })
}

/**
 * Reads a JSON problem body (`application/json`, `application/problem+json`
 * or another `+json` type), or `undefined` when the response has no body or a
 * non-JSON one.
 *
 * @param response {Response}
 * @returns {Promise<any>}
 */
async function readProblem(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/([^+\s;]+\+)?json\s*(;.*)?$/i.test(contentType)) {
    return undefined
  }
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

/**
 * Splits an `Allow` header into its method tokens.
 *
 * @param allow {string | null}
 * @returns {string[]}
 */
function allowedMethods(allow: string | null): string[] {
  return (allow ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

/**
 * Sends a signed request for a method this specification does not define at
 * `url`, and asserts the spec "Methods at Reserved Endpoints" refusal: `405`
 * and an `Allow` header that does not name the refused method. A problem
 * body is optional. When a JSON one is sent, its `type` must be `about:blank`
 * and it must carry the `title` Error Handling requires. When `tolerate501`
 * is set, a `501 unsupported-operation` is also accepted -- the endpoint's
 * whole feature group may be unimplemented, in which case the group's own
 * rule governs instead of this subsection.
 *
 * @param options {object}
 * @param options.invocationSigner {ISigner}
 * @param options.url {string}
 * @param options.method {string}
 * @param [options.tolerate501] {boolean}
 * @returns {Promise<{ status: number; allow: string }>}
 */
async function assertMethodRefused({
  invocationSigner,
  url,
  method,
  tolerate501
}: {
  invocationSigner: ISigner
  url: string
  method: string
  tolerate501?: boolean
}): Promise<{ status: number; allow: string }> {
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const response = await signedRequest({
    url,
    method,
    invocationSigner,
    ...(needsBody && { json: {} })
  })
  if (tolerate501 && response.status === 501) {
    return { status: 501, allow: '' }
  }
  assert.equal(
    response.status,
    405,
    `expected 405 for ${method} ${url}, got ${response.status}`
  )
  const allowHeader = response.headers.get('allow')
  assert.ok(
    allowHeader !== null,
    `expected an Allow header on the 405 refusing ${method} ${url}`
  )
  const allow = allowHeader ?? ''
  assert.ok(
    !allowedMethods(allow).includes(method),
    `Allow header should not list ${method} for ${url} (got "${allow}")`
  )
  const problem = await readProblem(response)
  if (problem !== undefined) {
    assert.equal(
      problem.type,
      'about:blank',
      `expected an about:blank problem type refusing ${method} ${url}`
    )
    assert.equal(
      typeof problem.title,
      'string',
      `expected a problem title refusing ${method} ${url}`
    )
  }
  return { status: 405, allow }
}

/**
 * Builds the URL for a reserved segment at the given container level. A
 * segment the path builders cover goes through its builder. The rest are
 * appended to the container URL the builders form.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.level {'space' | 'collection' | 'resource'}
 * @param options.segment {string}   the reserved segment, e.g. `meta`
 * @returns {string}
 */
function reservedEndpointUrl({
  serverUrl,
  spaceId,
  collectionId,
  resourceId,
  level,
  segment
}: {
  serverUrl: string
  spaceId: string
  collectionId: string
  resourceId: string
  level: 'space' | 'collection' | 'resource'
  segment: string
}): string {
  const spaceUrl = spaceUrlById({ baseServerUrl: serverUrl, spaceId })
  if (level === 'space') {
    const builders: Record<string, (() => string) | undefined> = {
      meta: () => spaceMetaUrl({ spaceUrl }),
      policy: () => spacePolicyUrl({ spaceUrl }),
      backends: () => spaceBackendsUrl({ spaceUrl }),
      export: () => spaceExportUrl({ spaceUrl }),
      import: () => spaceImportUrl({ spaceUrl }),
      linkset: () => spaceLinksetUrl({ spaceUrl }),
      quotas: () => spaceQuotasUrl({ spaceUrl })
    }
    // `collections` is the retired segment and `query` has no Space-level
    // builder, so those are appended by hand.
    return builders[segment]?.() ?? `${spaceUrl}${segment}`
  }
  if (level === 'collection') {
    const ids = { spaceUrl, collectionId }
    const builders: Record<string, (() => string) | undefined> = {
      policy: () => collectionPolicyUrl(ids),
      backend: () => collectionBackendUrl(ids),
      linkset: () => collectionLinksetUrl(ids),
      meta: () => collectionMetaUrl(ids),
      'meta/log': () => collectionLogUrl(ids),
      quota: () => collectionQuotaUrl(ids)
    }
    // Any other segment is appended by hand.
    return builders[segment]?.() ?? `${collectionUrl(ids)}${segment}`
  }
  const ids = { spaceUrl, collectionId, resourceId }
  const builders: Record<string, (() => string) | undefined> = {
    meta: () => resourceMetaUrl(ids),
    'chunks/': () => resourceChunksUrl(ids),
    policy: () => resourcePolicyUrl(ids)
  }
  // Any other segment is appended by hand.
  return builders[segment]?.() ?? `${resourceUrl(ids)}/${segment}`
}

/**
 * One reserved-segment table entry: a level, its reserved path segment, the
 * method(s) this specification never assigns an operation to there, and
 * whether the endpoint's whole feature group is an OPTIONAL extension a
 * conformant server may not implement at all (in which case a 501 is
 * accepted in place of the 405).
 */
interface ReservedEndpointCheck {
  id: string
  name: string
  level: 'space' | 'collection' | 'resource'
  segment: string
  methods: string[]
  tolerate501: boolean
  specRefs: string[]
}

const RESERVED_ENDPOINT_CHECKS: ReservedEndpointCheck[] = [
  // Space-level reserved endpoints (spec "Space-level reserved endpoints").
  {
    id: 'reserved-methods.space-meta-delete',
    name: '[root] DELETE /space/:s/meta is refused (405)',
    level: 'space',
    segment: 'meta',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-metadata-data-model',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-policy-patch',
    name: '[root] PATCH /space/:s/policy is refused (405)',
    level: 'space',
    segment: 'policy',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-backends-patch',
    name: '[root] PATCH /space/:s/backends is refused (405)',
    level: 'space',
    segment: 'backends',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-backends-available',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-collections-retired',
    name:
      '[root] DELETE/PATCH /space/:s/collections are refused (405) -- the ' +
      'retired segment defines no operation',
    level: 'space',
    segment: 'collections',
    methods: ['DELETE', 'PATCH'],
    tolerate501: false,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-export-get',
    name: '[root] GET /space/:s/export is refused (405)',
    level: 'space',
    segment: 'export',
    methods: ['GET'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-import-get',
    name: '[root] GET /space/:s/import is refused (405)',
    level: 'space',
    segment: 'import',
    methods: ['GET'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-linkset-delete',
    name: '[root] DELETE /space/:s/linkset is refused (405)',
    level: 'space',
    segment: 'linkset',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#space-linkset',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-query-refused',
    name:
      '[root] GET/PUT/DELETE/PATCH /space/:s/query are refused (405) -- no ' +
      'cross-collection query operation is defined for them',
    level: 'space',
    segment: 'query',
    methods: ['GET', 'PUT', 'DELETE', 'PATCH'],
    tolerate501: false,
    specRefs: [
      'https://w3id.org/pws#space-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.space-quotas-put',
    name: '[root] PUT /space/:s/quotas is refused (405)',
    level: 'space',
    segment: 'quotas',
    methods: ['PUT'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#quotas',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  // Collection-level reserved endpoints (spec "Collection-level reserved
  // endpoints"). The Collection need not exist -- the refusal reads no ids.
  {
    id: 'reserved-methods.collection-policy-patch',
    name: '[root] PATCH /space/:s/:c/policy is refused (405)',
    level: 'collection',
    segment: 'policy',
    methods: ['PATCH'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-backend-delete',
    name: '[root] DELETE /space/:s/:c/backend is refused (405)',
    level: 'collection',
    segment: 'backend',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-backend-selected',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-linkset-delete',
    name: '[root] DELETE /space/:s/:c/linkset is refused (405)',
    level: 'collection',
    segment: 'linkset',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-linkset',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-meta-delete',
    name: '[root] DELETE /space/:s/:c/meta is refused (405)',
    level: 'collection',
    segment: 'meta',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-metadata-data-model',
      'https://w3id.org/pws#collection-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-meta-log-delete',
    name: '[root] DELETE /space/:s/:c/meta/log is refused (405)',
    level: 'collection',
    segment: 'meta/log',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#collection-governing-history-log',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.collection-quota-put',
    name: '[root] PUT /space/:s/:c/quota is refused (405)',
    level: 'collection',
    segment: 'quota',
    methods: ['PUT'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#quotas',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  // Resource-level reserved endpoints (spec "Resource-level reserved
  // endpoints"). Neither the Collection nor the Resource need exist.
  {
    id: 'reserved-methods.resource-meta-post',
    name: '[root] POST /space/:s/:c/:r/meta is refused (405)',
    level: 'resource',
    segment: 'meta',
    methods: ['POST'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws#resource-metadata-data-model',
      'https://w3id.org/pws#resource-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  },
  {
    id: 'reserved-methods.resource-chunks-delete',
    name: '[root] DELETE /space/:s/:c/:r/chunks/ is refused (405)',
    level: 'resource',
    segment: 'chunks/',
    methods: ['DELETE'],
    tolerate501: true,
    specRefs: [
      'https://w3id.org/pws/encrypted-collections#chunked-resources',
      'https://w3id.org/pws#resource-level-reserved-endpoints',
      'https://w3id.org/pws#methods-at-reserved-endpoints'
    ]
  }
]

const reservedEndpointTests: Array<TestCase<State>> =
  RESERVED_ENDPOINT_CHECKS.map(check => ({
    id: check.id,
    name: check.name,
    specRefs: check.specRefs,
    run: async (ctx, state) => {
      const { alice, collectionId, resourceId } = state
      const url = reservedEndpointUrl({
        serverUrl: ctx.serverUrl,
        spaceId: alice.space1.id,
        collectionId,
        resourceId,
        level: check.level,
        segment: check.segment
      })
      for (const method of check.methods) {
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method,
          tolerate501: check.tolerate501
        })
      }
    }
  }))

export const reservedMethodsApi: Suite<State> = {
  id: 'reserved-methods-api',
  name: 'Methods at reserved endpoints (405)',
  specRefs: [
    'https://w3id.org/pws#reserved-path-segment-registry',
    'https://w3id.org/pws#methods-at-reserved-endpoints'
  ],

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    alice.space1 = { id: ctx.generateId() }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Reserved-Methods Space",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    return {
      alice,
      // Neither Collection nor Resource need exist: the refusal reads no
      // ids, so a plain literal id exercises the same code path as a real
      // one without any provisioning cost.
      collectionId: 'reserved-methods-collection',
      resourceId: 'reserved-methods-resource'
    }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: spaceUrlById({
          baseServerUrl: ctx.serverUrl,
          spaceId: alice.space1.id
        }),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    ...reservedEndpointTests,
    {
      id: 'reserved-methods.space-container-put',
      name: '[root] PUT /space/:s/ is refused (405), Allow excludes PUT',
      specRefs: [
        'https://w3id.org/pws#space-metadata-data-model',
        'https://w3id.org/pws#methods-at-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const url = spaceUrlById({
          baseServerUrl: ctx.serverUrl,
          spaceId: alice.space1.id
        })
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method: 'PUT'
        })
      }
    },
    {
      id: 'reserved-methods.collection-container-put',
      name: '[root] PUT /space/:s/:c/ is refused (405), Allow excludes PUT',
      specRefs: [
        'https://w3id.org/pws#collection-metadata-data-model',
        'https://w3id.org/pws#methods-at-reserved-endpoints'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId } = state
        const url = collectionUrl({
          spaceUrl: spaceUrlById({
            baseServerUrl: ctx.serverUrl,
            spaceId: alice.space1.id
          }),
          collectionId
        })
        await assertMethodRefused({
          invocationSigner: alice.rootClient.invocationSigner,
          url,
          method: 'PUT'
        })
      }
    },
    {
      id: 'reserved-methods.identical-for-absent-space',
      name: '[root] the 405 refusal is identical whether the Space exists',
      specRefs: [
        'https://w3id.org/pws#methods-at-reserved-endpoints',
        'https://w3id.org/pws#error-handling'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const answers: Array<{ status: number; allow: string }> = []
        for (const spaceId of [alice.space1.id, `absent-${ctx.generateId()}`]) {
          const url = spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
          answers.push(
            await assertMethodRefused({
              invocationSigner: alice.rootClient.invocationSigner,
              url,
              method: 'PUT'
            })
          )
        }
        assert.equal(answers[0]!.status, 405)
        assert.deepStrictEqual(
          answers[1],
          answers[0],
          'the refusal must read no ids: an absent Space gets the same answer'
        )
      }
    },
    {
      id: 'reserved-methods.head-follows-get',
      name:
        '[root] HEAD is not refused where GET is defined at a reserved ' +
        'endpoint',
      optional: true,
      specRefs: [
        'https://w3id.org/pws#methods-at-reserved-endpoints',
        'https://w3id.org/pws#space-linkset'
      ],
      run: async (ctx, state) => {
        const { alice } = state
        const url = reservedEndpointUrl({
          serverUrl: ctx.serverUrl,
          spaceId: alice.space1.id,
          collectionId: state.collectionId,
          resourceId: state.resourceId,
          level: 'space',
          segment: 'linkset'
        })
        const getResponse = await signedRequest({
          url,
          method: 'GET',
          invocationSigner: alice.rootClient.invocationSigner
        })
        if (getResponse.status === 501) {
          ctx.skip('Space Linkset (GET) not implemented (501)')
        }
        assert.notEqual(
          getResponse.status,
          405,
          'GET should not itself be refused'
        )
        const headResponse = await signedRequest({
          url,
          method: 'HEAD',
          invocationSigner: alice.rootClient.invocationSigner
        })
        // A HEAD is authorized as a GET, so it gets the GET's answer.
        assert.equal(
          headResponse.status,
          getResponse.status,
          'HEAD should follow GET rather than being refused'
        )
      }
    },
    {
      id: 'reserved-methods.options-preflight-not-refused',
      name:
        '[root] an OPTIONS CORS preflight at a reserved endpoint is not ' +
        'refused',
      optional: true,
      specRefs: ['https://w3id.org/pws#methods-at-reserved-endpoints'],
      run: async (ctx, state) => {
        const { alice } = state
        const url = reservedEndpointUrl({
          serverUrl: ctx.serverUrl,
          spaceId: alice.space1.id,
          collectionId: state.collectionId,
          resourceId: state.resourceId,
          level: 'space',
          segment: 'linkset'
        })
        const response = await fetch(url, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://app.example',
            'access-control-request-method': 'DELETE'
          }
        })
        assert.notEqual(
          response.status,
          405,
          'an OPTIONS preflight must not be caught by the reserved-methods ' +
            'refusal'
        )
      }
    }
  ]
}
