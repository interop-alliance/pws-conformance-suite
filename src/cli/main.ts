/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The testable core of the `was-conformance` CLI: parse argv into a config,
 * run the suite through the injected `runConformance`, stream events to the
 * chosen reporter, and map the result to an exit code. The bin entry
 * (`index.ts`) is a thin wrapper that binds the real process I/O to this.
 */
import { parseArgs } from 'node:util'
import { runConformance } from '../index.js'
import { createPrettyReporter } from './reporters/pretty.js'
import { createJsonReporter } from './reporters/json.js'
import type { RunEvent, RunReport, Suite } from '../harness/types.js'

/** The I/O and collaborators the CLI needs, injectable for tests. */
export interface CliDeps {
  runConformance: typeof runConformance
  /** The suite registry to draw from (default: the full registry). */
  suites: Array<Suite<any>>
  /** Connectivity probe; any resolved response counts as reachable. */
  fetch: typeof fetch
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
  /** Whether stdout is a TTY, used (with NO_COLOR) to gate ANSI color. */
  isTTY: boolean
  /** This tool's version, read from its package by the bin wrapper. */
  version: string
  /** The `@interop/was-client` version, if cheaply resolvable. */
  clientVersion?: string
}

/** A validated run configuration, produced by `parseArgv`. */
interface RunConfig {
  serverUrl: string
  onboardingToken: string | null
  suiteIds: string[]
  grep: string | null
  includeOptional: boolean
  skipOptional: boolean
  reporter: 'pretty' | 'json'
  timeoutMs: number | null
  failFast: boolean
}

type ParseResult =
  | { kind: 'run'; config: RunConfig }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage'; message: string }

const HELP = `Usage: pws-conformance <server-url> [options]

Runs the PWS conformance suite against a running server.
<server-url> falls back to the TEST_SERVER_URL environment variable.

Options:
  -t, --token <token>       onboarding token (or TEST_ONBOARDING_TOKEN)
  -s, --suite <id>          run only the named suite(s), repeatable
  -g, --grep <pattern>      filter tests by name
      --include-optional    treat optional tests as required (default: run
                            them but report as warnings)
      --skip-optional       do not run optional tests at all
  -r, --reporter <name>     pretty (default) | json
      --timeout <ms>        per-test timeout
      --fail-fast           stop on first failure
  -h, --help                show this help and exit
  -V, --version             print the version and exit`

/**
 * Parses argv (the tokens after `node script`) into a `ParseResult`, resolving
 * env fallbacks. Pure: it never touches the network or the suite registry, so
 * arg handling is unit-testable on its own.
 *
 * @param argv {string[]} the raw argument tokens
 * @param env {object} the environment (for TEST_SERVER_URL / token fallbacks)
 * @returns {ParseResult}
 */
export function parseArgv(
  argv: string[],
  env: Record<string, string | undefined>
): ParseResult {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        token: { type: 'string', short: 't' },
        suite: { type: 'string', short: 's', multiple: true },
        grep: { type: 'string', short: 'g' },
        'include-optional': { type: 'boolean' },
        'skip-optional': { type: 'boolean' },
        reporter: { type: 'string', short: 'r' },
        timeout: { type: 'string' },
        'fail-fast': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' }
      }
    })
  } catch (err) {
    return {
      kind: 'usage',
      message: err instanceof Error ? err.message : String(err)
    }
  }

  const { values, positionals } = parsed
  if (values.help) {
    return { kind: 'help' }
  }
  if (values.version) {
    return { kind: 'version' }
  }

  if (positionals.length > 1) {
    return {
      kind: 'usage',
      message: `unexpected argument: ${positionals[1]}`
    }
  }
  const serverUrl = positionals[0] ?? env.TEST_SERVER_URL
  if (!serverUrl) {
    return {
      kind: 'usage',
      message: 'missing <server-url> (or set TEST_SERVER_URL)'
    }
  }
  try {
    new URL(serverUrl)
  } catch {
    return { kind: 'usage', message: `invalid server URL: ${serverUrl}` }
  }

  const reporter = values.reporter ?? 'pretty'
  if (reporter !== 'pretty' && reporter !== 'json') {
    return {
      kind: 'usage',
      message: `unknown reporter: ${reporter} (expected 'pretty' or 'json')`
    }
  }

  if (values['include-optional'] && values['skip-optional']) {
    return {
      kind: 'usage',
      message: '--include-optional and --skip-optional are mutually exclusive'
    }
  }

  let timeoutMs: number | null = null
  if (values.timeout !== undefined) {
    const n = Number(values.timeout)
    if (!Number.isInteger(n) || n <= 0) {
      return {
        kind: 'usage',
        message: `invalid --timeout: ${values.timeout} (expected a positive integer of milliseconds)`
      }
    }
    timeoutMs = n
  }

  if (values.grep !== undefined) {
    try {
      new RegExp(values.grep)
    } catch {
      return {
        kind: 'usage',
        message: `invalid --grep pattern: ${values.grep}`
      }
    }
  }

  return {
    kind: 'run',
    config: {
      serverUrl,
      onboardingToken: values.token ?? env.TEST_ONBOARDING_TOKEN ?? null,
      suiteIds: values.suite ?? [],
      grep: values.grep ?? null,
      includeOptional: values['include-optional'] ?? false,
      skipOptional: values['skip-optional'] ?? false,
      reporter,
      timeoutMs,
      failFast: values['fail-fast'] ?? false
    }
  }
}

/**
 * Selects and shapes the suites to run from the registry per the config:
 * restrict to `--suite` ids, drop optional tests under `--skip-optional`, and
 * keep only `--grep`-matching tests. Suites left with no tests are dropped.
 * Returns the filtered suites, or a usage error string on a bad selector.
 *
 * @param registry {Suite[]} the full available registry
 * @param config {RunConfig}
 * @returns {Suite[] | {error: string}}
 */
function selectSuites(
  registry: Array<Suite<any>>,
  config: RunConfig
): Array<Suite<any>> | { error: string } {
  let selected = registry
  if (config.suiteIds.length > 0) {
    const known = new Set(registry.map(s => s.id))
    const unknown = config.suiteIds.filter(id => !known.has(id))
    if (unknown.length > 0) {
      return {
        error: `unknown suite(s): ${unknown.join(', ')}. Known suites: ${registry
          .map(s => s.id)
          .join(', ')}`
      }
    }
    const wanted = new Set(config.suiteIds)
    selected = registry.filter(s => wanted.has(s.id))
  }

  const grep = config.grep !== null ? new RegExp(config.grep, 'i') : null

  const shaped = selected
    .map(suite => {
      const suiteOptional = suite.optional ?? false
      const tests = suite.tests.filter(test => {
        if (
          config.skipOptional &&
          (suiteOptional || (test.optional ?? false))
        ) {
          return false
        }
        if (grep && !grep.test(test.name)) {
          return false
        }
        return true
      })
      return { ...suite, tests }
    })
    .filter(suite => suite.tests.length > 0)

  if (shaped.length === 0) {
    return { error: 'no tests matched the given filters' }
  }
  return shaped
}

/** Removes any userinfo/query/hash from a URL before it is reported/logged. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

/** Best-effort connectivity probe with a bounded timeout. */
async function isReachable(
  fetchImpl: typeof fetch,
  serverUrl: string
): Promise<boolean> {
  try {
    await fetchImpl(new URL(serverUrl), {
      method: 'GET',
      signal: AbortSignal.timeout(10_000)
    })
    // Any HTTP response -- even a 404 -- means the server is reachable.
    return true
  } catch {
    return false
  }
}

/**
 * The CLI entry point, minus process wiring. Returns the intended exit code:
 * 0 = all required tests passed, 1 = conformance failures, 2 = usage error or
 * unreachable server.
 *
 * @param argv {string[]} argument tokens (after `node script`)
 * @param deps {CliDeps} injected I/O and collaborators
 * @returns {Promise<number>} the exit code
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const parseResult = parseArgv(argv, deps.env)
  if (parseResult.kind === 'help') {
    deps.stdout(HELP + '\n')
    return 0
  }
  if (parseResult.kind === 'version') {
    deps.stdout(deps.version + '\n')
    return 0
  }
  if (parseResult.kind === 'usage') {
    deps.stderr(`error: ${parseResult.message}\n\n${HELP}\n`)
    return 2
  }

  const { config } = parseResult
  const selected = selectSuites(deps.suites, config)
  if ('error' in selected) {
    deps.stderr(`error: ${selected.error}\n`)
    return 2
  }

  const safeUrl = redactUrl(config.serverUrl)

  // Preflight: fail cleanly if the server cannot be reached, rather than
  // letting every suite cascade into connection failures.
  if (!(await isReachable(deps.fetch, config.serverUrl))) {
    deps.stderr(`error: cannot reach ${safeUrl}\n`)
    return 2
  }

  const reporter =
    config.reporter === 'json'
      ? createJsonReporter({
          write: deps.stdout,
          writeErr: deps.stderr,
          tool: {
            name: 'pws-conformance',
            version: deps.version,
            ...(deps.clientVersion !== undefined && {
              clientVersion: deps.clientVersion
            })
          },
          serverUrl: safeUrl
        })
      : createPrettyReporter({
          write: deps.stdout,
          color: deps.isTTY && !deps.env.NO_COLOR,
          includeOptional: config.includeOptional,
          serverUrl: safeUrl
        })

  let report: RunReport
  try {
    report = await deps.runConformance({
      serverUrl: config.serverUrl,
      onboardingToken: config.onboardingToken,
      suites: selected,
      onEvent: (event: RunEvent) => reporter(event),
      ...(config.timeoutMs !== null && { testTimeoutMs: config.timeoutMs }),
      failFast: config.failFast
    })
  } catch (err) {
    deps.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  // Exit code: optional failures never fail the run unless --include-optional
  // promotes them. `conformant` already means fail === optionalFail.
  const passed = config.includeOptional
    ? report.counts.fail === 0
    : report.conformant
  return passed ? 0 : 1
}
