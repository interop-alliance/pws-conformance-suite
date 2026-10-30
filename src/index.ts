/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { runSuites } from './harness/runner.js'
import { createContext } from './helpers.js'
import { suites } from './suites/index.js'
import type { RunEvent, RunReport, Suite } from './harness/types.js'

export * from './harness/types.js'
export { runSuites, DEFAULT_TEST_TIMEOUT_MS } from './harness/runner.js'
export { default as assert } from './harness/assert.js'
export {
  buildZcapClients,
  createContext,
  createSpace,
  generateId,
  provisionSpace,
  pwsClient,
  withoutCreatedBy,
  withoutCreatingStamp,
  withoutReplicas,
  withoutWriteStamp,
  assertWriteStamp,
  zcapClient
} from './helpers.js'
export * from './suites/index.js'

/**
 * Runs the conformance suite (or a subset) against a WAS server.
 *
 * @param options {object}
 * @param options.serverUrl {string} base URL of the server under test
 * @param [options.onboardingToken] {string|null} provisioning token, if the
 *   server gates space creation
 * @param [options.suites] {Suite[]} subset to run (default: full registry)
 * @param [options.onEvent] {Function} live progress-event callback
 * @param [options.testTimeoutMs] {number} per-test timeout
 * @param [options.failFast] {boolean} stop on first non-optional failure
 * @returns {Promise<RunReport>}
 */
export async function runConformance({
  serverUrl,
  onboardingToken = null,
  suites: selectedSuites = suites,
  onEvent,
  testTimeoutMs,
  failFast
}: {
  serverUrl: string
  onboardingToken?: string | null
  suites?: Array<Suite<any>>
  onEvent?: (event: RunEvent) => void
  testTimeoutMs?: number
  failFast?: boolean
}): Promise<RunReport> {
  const ctx = await createContext({ serverUrl, onboardingToken })
  return runSuites({
    suites: selectedSuites,
    ctx,
    onEvent,
    testTimeoutMs,
    failFast
  })
}
