/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import type { PwsClient, Space } from '@interop/pws-client'
import type { ZcapClient } from '@interop/ezcap'
import type { ISigner } from '@interop/data-integrity-core'

/**
 * A test identity with full (root) authority: a low-level ZcapClient for raw
 * request()/delegate() calls and a high-level PwsClient wrapping the same
 * signer. Suites may stash per-suite scratch data (space ids, etc.) on a
 * shallow clone of an actor -- never on the shared instance itself.
 */
export interface Actor {
  did: string
  /**
   * The identity's own signer. `rootClient` and `pws` are built from it; a
   * suite needs it directly only to build a client of its own, e.g. one signing
   * delegation proofs with a different cryptosuite.
   */
  signer: ISigner
  rootClient: ZcapClient
  pws: PwsClient
}

/** A delegated-app identity: no root authority, just a signer to invoke with. */
export interface DelegatedActor {
  did: string
  signer: ISigner
}

/** The deterministic test identities, built once per run. */
export interface Actors {
  alice: Actor
  aliceDelegatedApp: DelegatedActor
  bob: Actor
}

/**
 * Everything a conformance run needs, built once per run by
 * `createContext()`: the target server, the test identities, and the
 * provisioning/utility helpers bound to that server.
 */
export interface ConformanceContext {
  serverUrl: string
  onboardingToken: string | null
  actors: Actors
  /**
   * Creates a space via the onboarding token (if configured) or a signed
   * ZCap request, returning the raw status/headers/data for assertions.
   */
  createSpace: (options: {
    spaceDescription: object
    rootClient: ZcapClient
  }) => Promise<{ status: number; headers: Headers; data: any }>
  /**
   * Creates a space by id with a `PUT` of its Space Metadata object: unsigned
   * with the onboarding token (if configured), else a signed ZCap request.
   * Returns the raw status/headers/data for assertions.
   */
  createSpaceByPut: (options: {
    spaceId: string
    spaceDescription: object
    rootClient: ZcapClient
    headers?: Record<string, string>
  }) => Promise<{ status: number; headers: Headers; data: any }>
  /**
   * Provisions a Space for the high-level PwsClient suites, via the
   * onboarding token when configured, else the client's signed createSpace.
   */
  provisionSpace: (options: { pws: PwsClient; name?: string }) => Promise<Space>
  /** Builds a high-level PWS client for a signer, bound to this server. */
  pwsClient: (options: { signer: ISigner }) => PwsClient
  /** Builds a low-level ZCap client for a signer. */
  zcapClient: (options: { signer: ISigner }) => ZcapClient
  /** Generates a fresh UUID (space/collection/resource id). */
  generateId: () => string
  /** Strips the OPTIONAL `createdBy` property before exact-shape comparison. */
  withoutCreatedBy: (value: unknown) => unknown
}

/**
 * The context passed to each test's `run`: the run context plus a
 * first-class skip escape (throws; the runner records a skip result).
 */
export interface TestContext extends ConformanceContext {
  skip: (reason?: string) => never
}

export interface TestCase<S = any> {
  /** Stable slug, e.g. 'spaces.create-post'. Unique within the suite. */
  id: string
  /** Human-readable name -- the original it() description, verbatim. */
  name: string
  /** Nested describe() label this test belonged to, for display grouping. */
  group?: string
  /**
   * Marks a test that reflects reference-server behavior rather than a clear
   * spec MUST. Optional tests run by default but their failures are reported
   * as warnings, not conformance failures.
   */
  optional?: boolean
  /** Deep links into the WAS spec that this test asserts. */
  specRefs?: string[]
  run: (ctx: TestContext, state: S) => Promise<void>
}

/** A nested describe() that had its own before() hook. */
export interface SuiteGroup<S = any> {
  /** Matches the `group` field of the tests it sets up. */
  name: string
  /** Runs once, before the first test of the group. May extend `state`. */
  setup: (ctx: ConformanceContext, state: S) => Promise<void>
}

export interface Suite<S = any> {
  /** Stable slug, e.g. 'spaces-api'. */
  id: string
  /** Human-readable name -- the original describe() description, verbatim. */
  name: string
  /** Marks every test in the suite optional (see TestCase.optional). */
  optional?: boolean
  specRefs?: string[]
  /** Replaces the original before() hook; its return value is the suite state. */
  setup?: (ctx: ConformanceContext) => Promise<S>
  /** Replaces the original after() hook. Best-effort: failures never affect results. */
  teardown?: (ctx: ConformanceContext, state: S) => Promise<void>
  /** Setup hooks for nested describes, keyed by group name. */
  groups?: Array<SuiteGroup<S>>
  /** Ordered flat list; tests carrying a `group` label sit in declaration order. */
  tests: Array<TestCase<S>>
}

export type TestStatus = 'pass' | 'fail' | 'skip'

export interface TestError {
  message: string
  /** Present when the failure was an AssertionError. */
  expected?: unknown
  actual?: unknown
  operator?: string
  stack?: string
}

export interface TestResult {
  suiteId: string
  testId: string
  name: string
  group?: string
  /** Effective flag: the test's own `optional` or its suite's. */
  optional: boolean
  status: TestStatus
  durationMs: number
  error?: TestError
  skipReason?: string
  specRefs?: string[]
}

/**
 * Aggregate counts. `fail` includes optional-test failures; `optionalFail`
 * is that subset. A run is conformant when `fail === optionalFail`.
 */
export interface RunCounts {
  total: number
  pass: number
  fail: number
  skip: number
  optionalFail: number
}

export interface SuiteResult {
  suiteId: string
  name: string
  optional: boolean
  durationMs: number
  counts: RunCounts
  results: TestResult[]
  /** Present when the suite's teardown hook threw (best-effort cleanup). */
  teardownError?: string
}

export interface RunReport {
  serverUrl: string
  startedAt: string
  durationMs: number
  counts: RunCounts
  /** True when no non-optional test failed. */
  conformant: boolean
  suites: SuiteResult[]
}

export type RunEvent =
  | {
      type: 'run-start'
      serverUrl: string
      suiteCount: number
      testCount: number
    }
  | {
      type: 'suite-start'
      suiteId: string
      name: string
      optional: boolean
      testCount: number
    }
  | {
      type: 'test-start'
      suiteId: string
      testId: string
      name: string
      group?: string
      optional: boolean
    }
  | { type: 'test-end'; result: TestResult }
  | { type: 'suite-end'; result: SuiteResult }
  | { type: 'run-end'; report: RunReport }
