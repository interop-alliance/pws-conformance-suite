/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Service Description (spec "Service Description",
 * "Discovering the Service Description", "Service Description Data Model",
 * "Read Service Description operation").
 *
 * The service description has no fixed path, so every test here reaches it
 * the spec-mandated way: by following the `Link: rel="service"` header off an
 * ordinary response, never by assuming `/service`. All requests are
 * unauthenticated plain `fetch()` calls -- the document requires no
 * authorization, and neither does discovering it -- and no Space is
 * provisioned: the checks that need a Space URL only need one that need not
 * exist (an absent Space still carries the header, and the no-slash-to-slash
 * redirect reads no ids).
 */
import { spacesUrl } from '@interop/was-client/paths'
import assert from '../harness/assert.js'
import type { Suite } from '../harness/types.js'

interface State {
  /** The service description's own absolute URL, discovered via `Link`. */
  serviceUrl: string
}

/**
 * One parsed RFC 8288 `Link` header value: its target URI-reference and its
 * `rel` parameter (empty when absent).
 */
interface LinkHeaderEntry {
  target: string
  rel: string
}

/**
 * Parses an RFC 8288 `Link` header into its comma-separated link values. The
 * split point is a comma immediately followed by the next value's opening
 * `<`, so a comma inside a quoted parameter (e.g. a `title` with a comma)
 * does not split the entry.
 *
 * @param header {string}   the raw `Link` header value
 * @returns {LinkHeaderEntry[]}
 */
function parseLinkHeader(header: string): LinkHeaderEntry[] {
  return header
    .split(/,(?=\s*<)/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const targetMatch = entry.match(/^<([^>]*)>/)
      const target = targetMatch ? targetMatch[1]! : ''
      const relMatch = entry.match(/;\s*rel\s*=\s*"?([^";]+)"?/i)
      const rel = relMatch ? relMatch[1]! : ''
      return { target, rel }
    })
}

/**
 * Reads the `service`-relation `Link` target off a response and resolves it
 * to an absolute URL against the response's own URL.
 *
 * @param response {Response}
 * @param base {string}   fallback base URL when the response carries none
 * @returns {string}
 */
function findServiceLink(response: Response, base: string): string {
  const header = response.headers.get('link')
  assert.ok(header, `expected a Link header on ${response.url || base}`)
  const links = parseLinkHeader(header!)
  const serviceLink = links.find(link => link.rel === 'service')
  assert.ok(
    serviceLink,
    `expected a Link header with rel="service" on ${response.url || base}`
  )
  return new URL(serviceLink!.target, response.url || base).toString()
}

/**
 * Asserts `Access-Control-Expose-Headers` names `Link` (case-insensitively,
 * as one of its comma-separated tokens).
 *
 * @param response {Response}
 */
function assertExposesLinkHeader(response: Response): void {
  const expose = response.headers.get('access-control-expose-headers') ?? ''
  const tokens = expose.split(',').map(token => token.trim().toLowerCase())
  assert.ok(
    tokens.includes('link'),
    `expected Access-Control-Expose-Headers to name Link, got "${expose}"`
  )
}

/**
 * Asserts a response carries a `service` link resolving to `expectedUrl` and
 * exposes it cross-origin.
 *
 * @param options {object}
 * @param options.response {Response}
 * @param options.base {string}   fallback base URL to resolve a relative target against
 * @param options.expectedUrl {string}   the service description URL discovered earlier
 */
function assertDiscoverable({
  response,
  base,
  expectedUrl
}: {
  response: Response
  base: string
  expectedUrl: string
}): void {
  const target = findServiceLink(response, base)
  assert.equal(
    target,
    expectedUrl,
    'the service Link must point at the same URL from every response'
  )
  assertExposesLinkHeader(response)
}

/**
 * Asserts `value` is `true` only if it parses as an absolute URL.
 *
 * @param value {unknown}
 * @param label {string}   description used in the failure message
 */
function assertAbsoluteUrl(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', `expected ${label} to be a string`)
  try {
    new URL(value as string)
  } catch (err) {
    assert.fail(
      `expected ${label} to be an absolute URL, got ${value!} (${err})`
    )
  }
}

/**
 * Asserts `value` is an array whose entries are all strings.
 *
 * @param value {unknown}
 * @param label {string}   description used in the failure message
 */
function assertArrayOfStrings(value: unknown, label: string): void {
  assert.ok(Array.isArray(value), `expected ${label} to be an array`)
  for (const entry of value as unknown[]) {
    assert.equal(
      typeof entry,
      'string',
      `expected each ${label} entry to be a string`
    )
  }
}

const VERSION_ENTRY_REGEX = /^\d+\.\d+$/

/**
 * The service description entry for this specification, in the shape
 * "Service Description Data Model" defines.
 */
interface PwsVersionEntry {
  version: string
  url?: string
  spaces?: string
  features?: string[]
  signatureAlgorithms?: string[]
  zcapCryptosuites?: string[]
}

export const serviceDescriptionApi: Suite<State> = {
  id: 'service-description-api',
  name: 'Service Description',
  specRefs: ['https://w3id.org/pws#service-description'],

  setup: async ctx => {
    // The spec's own discovery starts from any PWS URL the client holds. The
    // Spaces Repository URL is one; the server's root need not be (a wallet
    // may serve its own app there).
    const probeUrl = spacesUrl({ baseUrl: ctx.serverUrl })
    const response = await fetch(probeUrl)
    const serviceUrl = findServiceLink(response, probeUrl)
    assertAbsoluteUrl(serviceUrl, 'the discovered service description URL')
    return { serviceUrl }
  },

  tests: [
    {
      id: 'service-description.discovery-via-link-header',
      name: 'the service description is discovered via the Link rel="service" header, not a fixed path',
      specRefs: ['https://w3id.org/pws#discovering-the-service-description'],
      run: async (ctx, state) => {
        const probeUrl = spacesUrl({ baseUrl: ctx.serverUrl })
        const response = await fetch(probeUrl)
        const target = findServiceLink(response, probeUrl)
        assert.equal(
          target,
          state.serviceUrl,
          'repeated discovery must resolve to the same URL'
        )
      }
    },
    {
      id: 'service-description.link-on-success',
      name: 'the Link header is present on the service description itself (200), with ACAO: *',
      specRefs: [
        'https://w3id.org/pws#discovering-the-service-description',
        'https://w3id.org/pws#read-service-description-operation'
      ],
      run: async (ctx, state) => {
        const response = await fetch(state.serviceUrl, {
          headers: { origin: 'https://app.example' }
        })
        assert.equal(response.status, 200)
        assertDiscoverable({
          response,
          base: state.serviceUrl,
          expectedUrl: state.serviceUrl
        })
        assert.equal(
          response.headers.get('access-control-allow-origin'),
          '*',
          'the service description must be served with Access-Control-Allow-Origin: *'
        )
      }
    },
    {
      id: 'service-description.link-on-error',
      name: 'the Link header is present on an anonymous read of an absent Space (error response)',
      specRefs: ['https://w3id.org/pws#discovering-the-service-description'],
      run: async (ctx, state) => {
        const absentSpaceUrl = new URL(
          `/space/${ctx.generateId()}/`,
          ctx.serverUrl
        ).toString()
        const response = await fetch(absentSpaceUrl)
        assert.notEqual(response.status, 200)
        assertDiscoverable({
          response,
          base: ctx.serverUrl,
          expectedUrl: state.serviceUrl
        })
      }
    },
    {
      id: 'service-description.link-on-redirect',
      name: 'the Link header is present on a 308 slash-variant redirect',
      specRefs: ['https://w3id.org/pws#discovering-the-service-description'],
      run: async (ctx, state) => {
        const noSlashUrl = new URL(
          `/space/${ctx.generateId()}`,
          ctx.serverUrl
        ).toString()
        const response = await fetch(noSlashUrl, { redirect: 'manual' })
        assert.equal(response.status, 308)
        assertDiscoverable({
          response,
          base: ctx.serverUrl,
          expectedUrl: state.serviceUrl
        })
      }
    },
    {
      id: 'service-description.link-on-preflight',
      name: 'the Link header is present on a CORS preflight (OPTIONS)',
      specRefs: ['https://w3id.org/pws#discovering-the-service-description'],
      run: async (ctx, state) => {
        const targetUrl = new URL(
          `/space/${ctx.generateId()}/`,
          ctx.serverUrl
        ).toString()
        const response = await fetch(targetUrl, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://app.example',
            'access-control-request-method': 'GET'
          }
        })
        assertDiscoverable({
          response,
          base: ctx.serverUrl,
          expectedUrl: state.serviceUrl
        })
      }
    },
    {
      id: 'service-description.data-model',
      name: 'the document validates against the Service Description Data Model (no capability invocation)',
      specRefs: ['https://w3id.org/pws#service-description-data-model'],
      run: async (ctx, state) => {
        const response = await fetch(state.serviceUrl)
        assert.equal(response.status, 200)
        assert.match(
          response.headers.get('content-type') ?? '',
          /application\/json/
        )
        const document = (await response.json()) as {
          url: string
          specs: Record<string, PwsVersionEntry[]>
        }
        assertAbsoluteUrl(document.url, 'document.url')
        assert.equal(document.url, state.serviceUrl)
        assert.equal(typeof document.specs, 'object')
        assert.ok(document.specs && !Array.isArray(document.specs))
        for (const [specId, entries] of Object.entries(document.specs)) {
          assert.ok(
            Array.isArray(entries),
            `expected specs["${specId}"] to be an array`
          )
          for (const entry of entries) {
            assert.match(
              entry.version,
              VERSION_ENTRY_REGEX,
              `expected a bare major.minor version for "${specId}", got "${entry.version}"`
            )
            if (entry.url !== undefined) {
              assertAbsoluteUrl(entry.url, `specs["${specId}"] entry.url`)
            }
            if (entry.spaces !== undefined) {
              assertAbsoluteUrl(entry.spaces, `specs["${specId}"] entry.spaces`)
            }
          }
        }
      }
    },
    {
      id: 'service-description.pws-version-entry',
      name: 'the https://w3id.org/pws entry for version 0.5 has well-formed optional members',
      specRefs: ['https://w3id.org/pws#service-description-data-model'],
      run: async (ctx, state) => {
        const response = await fetch(state.serviceUrl)
        const document = (await response.json()) as {
          specs: Record<string, PwsVersionEntry[]>
        }
        const pwsEntries = document.specs['https://w3id.org/pws']
        assert.ok(
          Array.isArray(pwsEntries),
          'expected a https://w3id.org/pws entry in specs'
        )
        const entry = pwsEntries!.find(candidate => candidate.version === '0.5')
        assert.ok(
          entry,
          'expected a version "0.5" entry under https://w3id.org/pws'
        )
        if (entry!.features !== undefined) {
          assertArrayOfStrings(entry!.features, "the pws entry's features")
        }
        if (entry!.signatureAlgorithms !== undefined) {
          assertArrayOfStrings(
            entry!.signatureAlgorithms,
            "the pws entry's signatureAlgorithms"
          )
        }
        if (entry!.zcapCryptosuites !== undefined) {
          assertArrayOfStrings(
            entry!.zcapCryptosuites,
            "the pws entry's zcapCryptosuites"
          )
        }
      }
    },
    {
      id: 'service-description.pws-spaces-repository',
      name: "the pws entry's spaces URL, when present, answers GET as a Spaces Repository listing",
      specRefs: [
        'https://w3id.org/pws#service-description-data-model',
        'https://w3id.org/pws#spaces-repositories',
        'https://w3id.org/pws#list-spaces-operation'
      ],
      run: async (ctx, state) => {
        const response = await fetch(state.serviceUrl)
        const document = (await response.json()) as {
          specs: Record<string, PwsVersionEntry[]>
        }
        const entry = document.specs['https://w3id.org/pws']?.find(
          candidate => candidate.version === '0.5'
        )
        if (!entry?.spaces) {
          ctx.skip('this server does not advertise a Spaces Repository')
        }
        const repositoryResponse = await fetch(entry!.spaces!)
        assert.equal(repositoryResponse.status, 200)
        assert.match(
          repositoryResponse.headers.get('content-type') ?? '',
          /application\/json/
        )
        const listing = (await repositoryResponse.json()) as {
          items: unknown[]
        }
        assert.ok(
          Array.isArray(listing.items),
          'expected the Spaces Repository listing to carry an items array'
        )
      }
    },
    {
      id: 'service-description.cacheable',
      name: 'the document SHOULD be cacheable: Cache-Control and ETag, honored by a conditional re-read',
      optional: true,
      specRefs: ['https://w3id.org/pws#read-service-description-operation'],
      run: async (ctx, state) => {
        const response = await fetch(state.serviceUrl)
        assert.equal(response.status, 200)
        const etag = response.headers.get('etag')
        assert.ok(etag, 'expected an ETag on the service description')
        assert.ok(
          response.headers.get('cache-control'),
          'expected a Cache-Control header on the service description'
        )
        const conditionalResponse = await fetch(state.serviceUrl, {
          headers: { 'if-none-match': etag! }
        })
        assert.equal(conditionalResponse.status, 304)
        const body = await conditionalResponse.text()
        assert.equal(body, '', 'a 304 must not carry a body')
      }
    }
  ]
}
