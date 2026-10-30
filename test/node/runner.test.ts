/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import { runSuites, DEFAULT_TEST_TIMEOUT_MS } from '../../src/harness/runner.js'
import assert from '../../src/harness/assert.js'
import type {
  ConformanceContext,
  RunEvent,
  Suite,
  TestCase,
  TestContext
} from '../../src/harness/types.js'

/**
 * A minimal, network-free ConformanceContext. The runner reads `serverUrl` and
 * spreads the context into each TestContext; it never invokes the provisioning
 * helpers itself, so they are `as any` stubs that throw if a test touches them.
 */
function fakeContext(
  overrides: Partial<ConformanceContext> = {}
): ConformanceContext {
  const notCalled = (name: string) => () => {
    throw new Error(`fake context: ${name} should not be called`)
  }
  return {
    serverUrl: 'https://example.test',
    onboardingToken: null,
    actors: {} as any,
    createSpace: notCalled('createSpace') as any,
    createSpaceByPut: notCalled('createSpaceByPut') as any,
    provisionSpace: notCalled('provisionSpace') as any,
    pwsClient: notCalled('pwsClient') as any,
    zcapClient: notCalled('zcapClient') as any,
    generateId: (() => 'fake-id') as any,
    withoutCreatedBy: (value: unknown) => value,
    ...overrides
  }
}

/** Builds a TestCase with a no-op passing run, overridable per field. */
function testCase(id: string, overrides: Partial<TestCase> = {}): TestCase {
  return { id, name: id, run: async () => {}, ...overrides }
}

describe('runSuites', () => {
  it('exposes a generous default per-test timeout', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000)
  })

  it('records pass, fail, and skip statuses with numeric durations', async () => {
    const suite: Suite = {
      id: 'statuses',
      name: 'Statuses',
      tests: [
        testCase('ok'),
        testCase('bad', {
          run: async () => {
            throw new Error('boom')
          }
        }),
        testCase('skipped', {
          run: async (ctx: TestContext) => {
            ctx.skip('nope')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const [ok, bad, skipped] = report.suites[0]!.results

    expect(ok!.status).toBe('pass')
    expect(bad!.status).toBe('fail')
    expect(skipped!.status).toBe('skip')
    for (const result of report.suites[0]!.results) {
      expect(typeof result.durationMs).toBe('number')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('captures a thrown Error message and stack', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('t', {
          run: async () => {
            throw new Error('kaboom')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const error = report.suites[0]!.results[0]!.error!
    expect(error.message).toBe('kaboom')
    expect(typeof error.stack).toBe('string')
    expect(error.expected).toBeUndefined()
  })

  it('captures AssertionError expected/actual/operator fields', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('t', {
          run: async () => {
            assert.strictEqual(1, 2)
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const error = report.suites[0]!.results[0]!.error!
    expect(error.actual).toBe(1)
    expect(error.expected).toBe(2)
    expect(error.operator).toBe('strictEqual')
    expect(typeof error.message).toBe('string')
    expect(typeof error.stack).toBe('string')
  })

  it('emits events in run/suite/test order with correct payloads', async () => {
    const suite: Suite = {
      id: 'events',
      name: 'Events',
      tests: [testCase('only', { name: 'the only test' })]
    }
    const events: RunEvent[] = []
    const report = await runSuites({
      suites: [suite],
      ctx: fakeContext(),
      onEvent: e => events.push(e)
    })

    expect(events.map(e => e.type)).toEqual([
      'run-start',
      'suite-start',
      'test-start',
      'test-end',
      'suite-end',
      'run-end'
    ])

    const runStart = events[0] as Extract<RunEvent, { type: 'run-start' }>
    expect(runStart.serverUrl).toBe('https://example.test')
    expect(runStart.suiteCount).toBe(1)
    expect(runStart.testCount).toBe(1)

    const suiteStart = events[1] as Extract<RunEvent, { type: 'suite-start' }>
    expect(suiteStart.suiteId).toBe('events')
    expect(suiteStart.name).toBe('Events')
    expect(suiteStart.optional).toBe(false)
    expect(suiteStart.testCount).toBe(1)

    const testStart = events[2] as Extract<RunEvent, { type: 'test-start' }>
    expect(testStart).toMatchObject({
      suiteId: 'events',
      testId: 'only',
      name: 'the only test',
      optional: false
    })

    const testEnd = events[3] as Extract<RunEvent, { type: 'test-end' }>
    expect(testEnd.result.status).toBe('pass')
    expect(testEnd.result.testId).toBe('only')

    const suiteEnd = events[4] as Extract<RunEvent, { type: 'suite-end' }>
    expect(suiteEnd.result.suiteId).toBe('events')
    expect(suiteEnd.result.results).toHaveLength(1)

    const runEnd = events[5] as Extract<RunEvent, { type: 'run-end' }>
    expect(runEnd.report).toBe(report)
  })

  it('tallies total/pass/fail/skip/optionalFail counts', async () => {
    const fail = (id: string, optional?: boolean) =>
      testCase(id, {
        ...(optional !== undefined && { optional }),
        run: async () => {
          throw new Error('x')
        }
      })
    const suite: Suite = {
      id: 'counts',
      name: 'Counts',
      tests: [
        testCase('p1'),
        testCase('p2'),
        fail('f1'),
        fail('optf', true),
        testCase('sk', {
          run: async (ctx: TestContext) => ctx.skip()
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(report.counts).toEqual({
      total: 5,
      pass: 2,
      fail: 2,
      skip: 1,
      optionalFail: 1
    })
  })

  it('is not conformant when a non-optional test fails', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('t', {
          run: async () => {
            throw new Error('x')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(report.conformant).toBe(false)
  })

  it('stays conformant when only optional (test-level) tests fail', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('ok'),
        testCase('opt', {
          optional: true,
          run: async () => {
            throw new Error('x')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(report.conformant).toBe(true)
    expect(report.counts.fail).toBe(1)
    expect(report.counts.optionalFail).toBe(1)
  })

  it('inherits the suite-level optional flag onto its tests', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      optional: true,
      tests: [
        testCase('t', {
          run: async () => {
            throw new Error('x')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(report.suites[0]!.results[0]!.optional).toBe(true)
    expect(report.counts.optionalFail).toBe(1)
    expect(report.conformant).toBe(true)
  })

  it('fails every test in a suite whose setup throws, and skips teardown', async () => {
    let teardownRan = false
    const suite: Suite = {
      id: 'setup-fail',
      name: 'Setup Fail',
      setup: async () => {
        throw new Error('db down')
      },
      teardown: async () => {
        teardownRan = true
      },
      tests: [testCase('a'), testCase('b')]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const results = report.suites[0]!.results
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe('fail')
      expect(result.error!.message).toBe('suite setup failed: db down')
      expect(result.durationMs).toBe(0)
    }
    expect(teardownRan).toBe(false)
    expect(report.suites[0]!.teardownError).toBeUndefined()
  })

  it('runs a group setup lazily, once, before the first test of its group', async () => {
    const order: string[] = []
    const suite: Suite = {
      id: 'groups',
      name: 'Groups',
      groups: [
        {
          name: 'g1',
          setup: async () => {
            order.push('g1-setup')
          }
        }
      ],
      tests: [
        testCase('free', {
          run: async () => {
            order.push('free')
          }
        }),
        testCase('g1-a', {
          group: 'g1',
          run: async () => {
            order.push('g1-a')
          }
        }),
        testCase('g1-b', {
          group: 'g1',
          run: async () => {
            order.push('g1-b')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(order).toEqual(['free', 'g1-setup', 'g1-a', 'g1-b'])
    expect(order.filter(o => o === 'g1-setup')).toHaveLength(1)
    for (const result of report.suites[0]!.results) {
      expect(result.status).toBe('pass')
    }
  })

  it('fails the group tests when a group setup throws, sparing other tests', async () => {
    const suite: Suite = {
      id: 'groups',
      name: 'Groups',
      groups: [
        {
          name: 'g1',
          setup: async () => {
            throw new Error('no fixture')
          }
        }
      ],
      tests: [
        testCase('g1-a', { group: 'g1' }),
        testCase('g1-b', { group: 'g1' }),
        testCase('free')
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const [a, b, free] = report.suites[0]!.results
    expect(a!.status).toBe('fail')
    expect(a!.error!.message).toBe('group setup failed: no fixture')
    expect(b!.status).toBe('fail')
    expect(b!.error!.message).toBe('group setup failed: no fixture')
    expect(free!.status).toBe('pass')
  })

  it('threads suite state into group setups and tests', async () => {
    const seen: { group?: unknown; test?: unknown } = {}
    const suite: Suite<{ value: number; extended?: boolean }> = {
      id: 'state',
      name: 'State',
      setup: async () => ({ value: 42 }),
      groups: [
        {
          name: 'g1',
          setup: async (_ctx, state) => {
            seen.group = state.value
            state.extended = true
          }
        }
      ],
      tests: [
        testCase('g1-a', {
          group: 'g1',
          run: async (_ctx, state) => {
            seen.test = state
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(seen.group).toBe(42)
    expect(seen.test).toEqual({ value: 42, extended: true })
    expect(report.suites[0]!.results[0]!.status).toBe('pass')
  })

  it('captures a teardown error without affecting counts', async () => {
    const suite: Suite = {
      id: 'teardown',
      name: 'Teardown',
      setup: async () => ({}),
      teardown: async () => {
        throw new Error('cleanup failed')
      },
      tests: [testCase('t')]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    expect(report.suites[0]!.teardownError).toBe('cleanup failed')
    expect(report.suites[0]!.results[0]!.status).toBe('pass')
    expect(report.counts).toEqual({
      total: 1,
      pass: 1,
      fail: 0,
      skip: 0,
      optionalFail: 0
    })
  })

  it('fails a never-resolving test with a timeout message', async () => {
    const suite: Suite = {
      id: 'timeout',
      name: 'Timeout',
      tests: [
        testCase('hangs', {
          run: () => new Promise<void>(() => {})
        })
      ]
    }
    const report = await runSuites({
      suites: [suite],
      ctx: fakeContext(),
      testTimeoutMs: 50
    })
    const result = report.suites[0]!.results[0]!
    expect(result.status).toBe('fail')
    expect(result.error!.message).toBe('timed out after 50ms')
  })

  it('skips remaining tests across suites after a non-optional failure under failFast', async () => {
    const suiteOne: Suite = {
      id: 'one',
      name: 'One',
      tests: [
        testCase('ok'),
        testCase('bad', {
          run: async () => {
            throw new Error('x')
          }
        }),
        testCase('after')
      ]
    }
    const suiteTwo: Suite = {
      id: 'two',
      name: 'Two',
      tests: [testCase('later')]
    }
    const report = await runSuites({
      suites: [suiteOne, suiteTwo],
      ctx: fakeContext(),
      failFast: true
    })
    const [ok, bad, after] = report.suites[0]!.results
    expect(ok!.status).toBe('pass')
    expect(bad!.status).toBe('fail')
    expect(after!.status).toBe('skip')
    expect(after!.skipReason).toBe('skipped (fail-fast)')

    const later = report.suites[1]!.results[0]!
    expect(later.status).toBe('skip')
    expect(later.skipReason).toBe('skipped (fail-fast)')
  })

  it('does not trigger failFast on an optional failure', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('opt-bad', {
          optional: true,
          run: async () => {
            throw new Error('x')
          }
        }),
        testCase('still-runs')
      ]
    }
    const report = await runSuites({
      suites: [suite],
      ctx: fakeContext(),
      failFast: true
    })
    const [optBad, stillRuns] = report.suites[0]!.results
    expect(optBad!.status).toBe('fail')
    expect(stillRuns!.status).toBe('pass')
  })

  it('records a skip with its reason when ctx.skip(reason) is called', async () => {
    const suite: Suite = {
      id: 's',
      name: 'S',
      tests: [
        testCase('t', {
          run: async (ctx: TestContext) => {
            ctx.skip('not supported here')
          }
        })
      ]
    }
    const report = await runSuites({ suites: [suite], ctx: fakeContext() })
    const result = report.suites[0]!.results[0]!
    expect(result.status).toBe('skip')
    expect(result.skipReason).toBe('not supported here')
  })
})
