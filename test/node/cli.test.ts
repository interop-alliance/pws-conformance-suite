/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import { main, parseArgv } from '../../src/cli/main.js'
import { createPrettyReporter } from '../../src/cli/reporters/pretty.js'
import { createJsonReporter } from '../../src/cli/reporters/json.js'
import type { CliDeps } from '../../src/cli/main.js'
import type {
  RunCounts,
  RunEvent,
  RunReport,
  Suite,
  SuiteResult,
  TestResult
} from '../../src/harness/types.js'

/** A tiny two-suite registry: one required suite, one all-optional suite. */
const fakeRegistry: Array<Suite<any>> = [
  {
    id: 'alpha',
    name: 'Alpha',
    tests: [
      { id: 'alpha.one', name: 'does the first thing', run: async () => {} },
      { id: 'alpha.two', name: 'does the second thing', run: async () => {} }
    ]
  },
  {
    id: 'beta',
    name: 'Beta',
    optional: true,
    tests: [{ id: 'beta.one', name: 'optional check', run: async () => {} }]
  }
]

function counts(partial: Partial<RunCounts> = {}): RunCounts {
  return { total: 0, pass: 0, fail: 0, skip: 0, optionalFail: 0, ...partial }
}

/**
 * A fake `runConformance` that emits run-start/run-end and returns a report
 * with the given counts/conformant flag. No network, no real suites.
 */
function fakeRun(report: Partial<RunReport>): CliDeps['runConformance'] {
  return async ({ onEvent, serverUrl }) => {
    const full: RunReport = {
      serverUrl,
      startedAt: '2026-07-19T00:00:00.000Z',
      durationMs: 5,
      counts: counts(),
      conformant: true,
      suites: [],
      ...report
    }
    onEvent?.({
      type: 'run-start',
      serverUrl,
      suiteCount: full.suites.length,
      testCount: full.counts.total
    })
    onEvent?.({ type: 'run-end', report: full })
    return full
  }
}

function makeDeps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps
  out: string[]
  err: string[]
} {
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    runConformance: fakeRun({}),
    suites: fakeRegistry,
    fetch: (async () => ({ status: 200 })) as unknown as typeof fetch,
    stdout: t => out.push(t),
    stderr: t => err.push(t),
    env: {},
    isTTY: false,
    version: '9.9.9',
    ...overrides
  }
  return { deps, out, err }
}

describe('parseArgv', () => {
  it('reads the server URL from the first positional', () => {
    const r = parseArgv(['https://s.test'], {})
    expect(r).toMatchObject({ kind: 'run' })
    if (r.kind === 'run') {
      expect(r.config.serverUrl).toBe('https://s.test')
    }
  })

  it('falls back to TEST_SERVER_URL when no positional is given', () => {
    const r = parseArgv([], { TEST_SERVER_URL: 'https://env.test' })
    if (r.kind !== 'run') {
      throw new Error('expected run')
    }
    expect(r.config.serverUrl).toBe('https://env.test')
  })

  it('is a usage error with no URL and no env fallback', () => {
    const r = parseArgv([], {})
    expect(r).toMatchObject({ kind: 'usage' })
  })

  it.each([
    ['unparseable', 'not a url'],
    ['non-http(s)', 'ftp://s.test/'],
    ['with a query', 'https://s.test/?a=1'],
    ['with a bare trailing ?', 'https://s.test/?'],
    ['with a bare trailing #', 'https://s.test/#'],
    ['with userinfo', 'https://user@s.test/'],
    ['with an empty path segment', 'https://s.test//pws']
  ])('rejects a server URL that is %s', (_label, url) => {
    expect(parseArgv([url], {}).kind).toBe('usage')
  })

  it('applies the same rule to TEST_SERVER_URL', () => {
    const r = parseArgv([], { TEST_SERVER_URL: 'https://s.test/?' })
    expect(r.kind).toBe('usage')
  })

  it('reads token, suites (repeatable), grep, and flags', () => {
    const r = parseArgv(
      [
        'https://s.test',
        '-t',
        'secret',
        '-s',
        'alpha',
        '-s',
        'beta',
        '-g',
        'thing',
        '--fail-fast',
        '--timeout',
        '1500'
      ],
      {}
    )
    if (r.kind !== 'run') {
      throw new Error('expected run')
    }
    expect(r.config.onboardingToken).toBe('secret')
    expect(r.config.suiteIds).toEqual(['alpha', 'beta'])
    expect(r.config.grep).toBe('thing')
    expect(r.config.failFast).toBe(true)
    expect(r.config.timeoutMs).toBe(1500)
  })

  it('falls back to TEST_ONBOARDING_TOKEN for the token', () => {
    const r = parseArgv(['https://s.test'], { TEST_ONBOARDING_TOKEN: 'envtok' })
    if (r.kind !== 'run') {
      throw new Error('expected run')
    }
    expect(r.config.onboardingToken).toBe('envtok')
  })

  it('rejects an unknown reporter', () => {
    const r = parseArgv(['https://s.test', '-r', 'xml'], {})
    expect(r.kind).toBe('usage')
  })

  it('rejects a non-positive or non-integer --timeout', () => {
    expect(parseArgv(['https://s.test', '--timeout', '0'], {}).kind).toBe(
      'usage'
    )
    expect(parseArgv(['https://s.test', '--timeout', 'abc'], {}).kind).toBe(
      'usage'
    )
  })

  it('rejects mutually exclusive optional flags', () => {
    const r = parseArgv(
      ['https://s.test', '--include-optional', '--skip-optional'],
      {}
    )
    expect(r.kind).toBe('usage')
  })

  it('rejects an invalid grep pattern', () => {
    const r = parseArgv(['https://s.test', '-g', '('], {})
    expect(r.kind).toBe('usage')
  })

  it('detects --help and --version', () => {
    expect(parseArgv(['--help'], {}).kind).toBe('help')
    expect(parseArgv(['-V'], {}).kind).toBe('version')
  })
})

describe('cli main -- help/version/usage', () => {
  it('prints help and exits 0', async () => {
    const { deps, out } = makeDeps()
    const code = await main(['--help'], deps)
    expect(code).toBe(0)
    expect(out.join('')).toContain('Usage: pws-conformance')
  })

  it('prints the version and exits 0', async () => {
    const { deps, out } = makeDeps()
    const code = await main(['--version'], deps)
    expect(code).toBe(0)
    expect(out.join('').trim()).toBe('9.9.9')
  })

  it('exits 2 with usage on a missing URL', async () => {
    const { deps, err } = makeDeps()
    const code = await main([], deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('missing <server-url>')
  })

  it('exits 2 on an unknown suite id', async () => {
    const { deps, err } = makeDeps()
    const code = await main(['https://s.test', '-s', 'nope'], deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('unknown suite')
  })
})

describe('cli main -- preflight', () => {
  it('exits 2 with a clean message when the server is unreachable', async () => {
    const { deps, err } = makeDeps({
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    const code = await main(['http://127.0.0.1:9'], deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('cannot reach http://127.0.0.1:9')
  })
})

describe('cli main -- exit-code matrix', () => {
  it('exits 0 when the run is conformant', async () => {
    const { deps } = makeDeps({
      runConformance: fakeRun({
        conformant: true,
        counts: counts({ total: 2, pass: 2 })
      })
    })
    expect(await main(['https://s.test'], deps)).toBe(0)
  })

  it('exits 1 on a non-optional conformance failure', async () => {
    const { deps } = makeDeps({
      runConformance: fakeRun({
        conformant: false,
        counts: counts({ total: 2, pass: 1, fail: 1 })
      })
    })
    expect(await main(['https://s.test'], deps)).toBe(1)
  })

  it('exits 0 when only optional tests fail (default)', async () => {
    const { deps } = makeDeps({
      runConformance: fakeRun({
        conformant: true,
        counts: counts({ total: 2, pass: 1, fail: 1, optionalFail: 1 })
      })
    })
    expect(await main(['https://s.test'], deps)).toBe(0)
  })

  it('exits 1 when optional tests fail under --include-optional', async () => {
    const { deps } = makeDeps({
      runConformance: fakeRun({
        conformant: true,
        counts: counts({ total: 2, pass: 1, fail: 1, optionalFail: 1 })
      })
    })
    expect(await main(['https://s.test', '--include-optional'], deps)).toBe(1)
  })

  it('exits 2 when runConformance throws (e.g. context build failure)', async () => {
    const { deps, err } = makeDeps({
      runConformance: (async () => {
        throw new Error('boom')
      }) as unknown as CliDeps['runConformance']
    })
    expect(await main(['https://s.test'], deps)).toBe(2)
    expect(err.join('')).toContain('boom')
  })

  it('passes the filtered suites and options through to runConformance', async () => {
    let seen: any
    const { deps } = makeDeps({
      runConformance: (async (opts: any) => {
        seen = opts
        return fakeRun({})(opts)
      }) as unknown as CliDeps['runConformance']
    })
    await main(
      ['https://s.test', '-s', 'alpha', '-g', 'first', '--fail-fast'],
      deps
    )
    expect(seen.suites).toHaveLength(1)
    expect(seen.suites[0].id).toBe('alpha')
    expect(seen.suites[0].tests).toHaveLength(1)
    expect(seen.suites[0].tests[0].id).toBe('alpha.one')
    expect(seen.failFast).toBe(true)
  })

  it('drops optional tests under --skip-optional', async () => {
    let seen: any
    const { deps } = makeDeps({
      runConformance: (async (opts: any) => {
        seen = opts
        return fakeRun({})(opts)
      }) as unknown as CliDeps['runConformance']
    })
    await main(['https://s.test', '--skip-optional'], deps)
    // The all-optional 'beta' suite is dropped entirely.
    expect(seen.suites.map((s: Suite) => s.id)).toEqual(['alpha'])
  })
})

/** Builds a TestResult for reporter tests. */
function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    suiteId: 's',
    testId: 't',
    name: 'a test',
    optional: false,
    status: 'pass',
    durationMs: 1,
    ...overrides
  }
}

describe('pretty reporter', () => {
  function render(events: RunEvent[]): string {
    const out: string[] = []
    const reporter = createPrettyReporter({
      write: t => out.push(t),
      color: false,
      includeOptional: false,
      serverUrl: 'https://s.test'
    })
    for (const e of events) {
      reporter(e)
    }
    return out.join('')
  }

  it('marks pass, fail, and optional-fail (warning) distinctly', () => {
    const text = render([
      {
        type: 'test-end',
        result: testResult({ status: 'pass', name: 'good' })
      },
      {
        type: 'test-end',
        result: testResult({
          status: 'fail',
          name: 'bad',
          error: { message: 'nope' }
        })
      },
      {
        type: 'test-end',
        result: testResult({
          status: 'fail',
          optional: true,
          name: 'maybe',
          error: { message: 'meh' }
        })
      }
    ])
    expect(text).toContain('✓ good')
    expect(text).toContain('✗ bad')
    expect(text).toContain('nope')
    // Optional failure renders with the warning glyph, not the failure glyph.
    expect(text).toContain('⚠ maybe')
  })

  it('renders an expected/actual diff for assertion failures', () => {
    const text = render([
      {
        type: 'test-end',
        result: testResult({
          status: 'fail',
          name: 'cmp',
          error: { message: 'not equal', expected: 2, actual: 1 }
        })
      }
    ])
    expect(text).toContain('expected:')
    expect(text).toContain('actual:')
    expect(text).toContain('2')
    expect(text).toContain('1')
  })

  it('prints a per-suite summary and CONFORMANT verdict at run-end', () => {
    const suiteResult: SuiteResult = {
      suiteId: 'alpha',
      name: 'Alpha',
      optional: false,
      durationMs: 3,
      counts: counts({ total: 2, pass: 2 }),
      results: []
    }
    const report: RunReport = {
      serverUrl: 'https://s.test',
      startedAt: '2026-07-19T00:00:00.000Z',
      durationMs: 3,
      counts: counts({ total: 2, pass: 2 }),
      conformant: true,
      suites: [suiteResult]
    }
    const text = render([{ type: 'run-end', report }])
    expect(text).toContain('Summary')
    expect(text).toContain('Alpha')
    expect(text).toContain('CONFORMANT')
  })
})

describe('json reporter', () => {
  it('emits a single JSON document with tool metadata at run-end', () => {
    const out: string[] = []
    const reporter = createJsonReporter({
      write: t => out.push(t),
      writeErr: () => {},
      tool: {
        name: 'pws-conformance',
        version: '9.9.9',
        clientVersion: '1.2.3'
      },
      serverUrl: 'https://s.test'
    })
    const report: RunReport = {
      serverUrl: 'https://s.test',
      startedAt: '2026-07-19T00:00:00.000Z',
      durationMs: 3,
      counts: counts({ total: 1, pass: 1 }),
      conformant: true,
      suites: []
    }
    reporter({
      type: 'run-start',
      serverUrl: 'https://s.test',
      suiteCount: 0,
      testCount: 1
    })
    reporter({ type: 'run-end', report })
    // Only run-end produces output.
    expect(out).toHaveLength(1)
    const doc = JSON.parse(out[0]!)
    expect(doc.tool).toEqual({
      name: 'pws-conformance',
      version: '9.9.9',
      clientVersion: '1.2.3'
    })
    expect(doc.serverUrl).toBe('https://s.test')
    expect(doc.conformant).toBe(true)
    expect(doc.counts.pass).toBe(1)
  })

  it('refuses a URL with credentials before probing, without echoing them', async () => {
    const out: string[] = []
    const err: string[] = []
    let probed = false
    const deps: CliDeps = {
      runConformance: fakeRun({
        conformant: true,
        counts: counts({ pass: 1, total: 1 })
      }),
      suites: fakeRegistry,
      fetch: (async () => {
        probed = true
        return { status: 200 }
      }) as unknown as typeof fetch,
      stdout: t => out.push(t),
      stderr: t => err.push(t),
      env: {},
      isTTY: false,
      version: '9.9.9'
    }
    const code = await main(
      ['https://user:pass@s.test/?token=abc', '-r', 'json'],
      deps
    )
    expect(code).toBe(2)
    expect(probed).toBe(false)
    expect(err.join('')).toContain('invalid server URL')
    expect(err.join('')).not.toContain('user:pass')
    expect(err.join('')).not.toContain('token=abc')
  })
})
