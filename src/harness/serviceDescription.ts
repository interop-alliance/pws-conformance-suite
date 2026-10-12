/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Reads a server's service description (spec "Service Description"), for the
 * suites that gate a check on a `features` token it advertises. Discovery
 * follows the spec's own route -- the `Link: <...>; rel="service"` header every
 * response carries -- rather than assuming a fixed path, so a server that
 * serves the document elsewhere is read correctly.
 */

import { spacesUrl } from '@interop/was-client/paths'

/** The WAS core specification's self-declared persistent identifier. */
export const PWS_SPEC_IDENTIFIER = 'https://w3id.org/pws'

/** The Encrypted Collections profile's self-declared persistent identifier. */
export const ENCRYPTED_COLLECTIONS_IDENTIFIER =
  'https://w3id.org/pws/encrypted-collections'

/**
 * Resolves the `service`-relation `Link` target of a response against the
 * response's own URL.
 *
 * @param response {Response}
 * @param base {string}   fallback base URL when the response carries none
 * @returns {string | undefined}   the absolute URL, or undefined when unlinked
 */
function serviceLinkOf(response: Response, base: string): string | undefined {
  const header = response.headers.get('link')
  if (header === null) {
    return undefined
  }
  const target = header
    .split(/,(?=\s*<)/)
    .map(entry => entry.trim())
    .filter(entry => /;\s*rel\s*=\s*"?service"?/i.test(entry))
    .map(entry => entry.match(/^<([^>]*)>/)?.[1])
    .find(Boolean)
  return target === undefined
    ? undefined
    : new URL(target, response.url || base).toString()
}

/**
 * Fetches a server's service description by following the `service` link off
 * its Spaces Repository URL, returning the parsed document. The spec's
 * discovery starts from any PWS URL; the server's root need not be one (a
 * wallet may serve its own app there), so the probe uses `/spaces/`. A server
 * that links no document, or does not serve one, yields `undefined` rather
 * than throwing -- the caller decides what an absent document means for its
 * gate.
 *
 * @param serverUrl {string}   the server's base URL
 * @returns {Promise<any | undefined>}
 */
export async function fetchServiceDescription(
  serverUrl: string
): Promise<any | undefined> {
  const probeUrl = spacesUrl({ baseUrl: serverUrl })
  const probeResponse = await fetch(probeUrl)
  const serviceUrl = serviceLinkOf(probeResponse, probeUrl)
  if (serviceUrl === undefined) {
    return undefined
  }
  const response = await fetch(serviceUrl)
  if (!response.ok) {
    return undefined
  }
  return response.json()
}

/**
 * Whether a server lists any version entry under a specification identifier.
 * Listing the Encrypted Collections profile is itself the claim that the chunk
 * endpoints are served -- no token names them -- so a suite testing those gates
 * on this rather than on a token.
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.specIdentifier {string}
 * @returns {Promise<boolean>}
 */
export async function servesSpec({
  serverUrl,
  specIdentifier
}: {
  serverUrl: string
  specIdentifier: string
}): Promise<boolean> {
  const document = await fetchServiceDescription(serverUrl)
  const entries = document?.specs?.[specIdentifier]
  return Array.isArray(entries) && entries.length > 0
}

/**
 * The `features` tokens a server advertises under one specification identifier,
 * gathered across every version entry listed for it. An unreachable or
 * unlinked document, an unknown identifier, or an entry without the array all
 * yield an empty list, so a caller reads a missing token as "not supported".
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param [options.specIdentifier] {string}   defaults to the WAS core spec
 * @returns {Promise<string[]>}
 */
export async function serviceFeatures({
  serverUrl,
  specIdentifier = PWS_SPEC_IDENTIFIER
}: {
  serverUrl: string
  specIdentifier?: string
}): Promise<string[]> {
  const document = await fetchServiceDescription(serverUrl)
  const entries = document?.specs?.[specIdentifier]
  if (!Array.isArray(entries)) {
    return []
  }
  return entries.flatMap((entry: any) =>
    Array.isArray(entry?.features) ? entry.features : []
  )
}
