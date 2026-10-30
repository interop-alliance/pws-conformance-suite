/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The default human reporter: live per-test lines, failure detail with an
 * expected/actual diff, and an end-of-run per-suite summary table. Colors are
 * plain ANSI escapes, gated by the caller (TTY and NO_COLOR), so there is no
 * color dependency.
 */
import { inspect } from 'node:util'
import type {
  RunEvent,
  SuiteResult,
  TestError,
  TestResult
} from '../../harness/types.js'

/** Builds ANSI wrappers that pass text through untouched when disabled. */
function makeStyle(enabled: boolean): Record<string, (s: string) => string> {
  const wrap =
    (code: string) =>
    (s: string): string =>
      enabled ? `\x1b[${code}m${s}\x1b[0m` : s
  return {
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    gray: wrap('90'),
    bold: wrap('1'),
    cyan: wrap('36')
  }
}

/** Renders a value for the expected/actual diff, one line where it fits. */
function show(value: unknown): string {
  return inspect(value, { depth: 4, breakLength: 72, sorted: true })
}

/**
 * Creates a pretty reporter: an `onEvent` handler that writes progress and,
 * at run-end, a summary. `includeOptional` promotes optional-test failures
 * from warnings to hard failures in the rendering, matching the exit-code
 * treatment.
 *
 * @param options {object}
 * @param options.write {Function} sink for a chunk of output (no trailing \n)
 * @param options.color {boolean} whether to emit ANSI color
 * @param options.includeOptional {boolean} render optional failures as failures
 * @param options.serverUrl {string} the target URL, for the header
 * @returns {(event: RunEvent) => void}
 */
export function createPrettyReporter({
  write,
  color,
  includeOptional,
  serverUrl
}: {
  write: (text: string) => void
  color: boolean
  includeOptional: boolean
  serverUrl: string
}): (event: RunEvent) => void {
  const s = makeStyle(color)
  const line = (text = ''): void => write(text + '\n')

  const glyphFor = (result: TestResult): string => {
    if (result.status === 'pass') {
      return s.green!('✓')
    }
    if (result.status === 'skip') {
      return s.gray!('○')
    }
    // A failing optional test is a warning unless --include-optional.
    if (result.optional && !includeOptional) {
      return s.yellow!('⚠')
    }
    return s.red!('✗')
  }

  const printError = (error: TestError, warn: boolean): void => {
    const label = warn ? s.yellow! : s.red!
    line(`      ${label(error.message)}`)
    if (error.expected !== undefined || error.actual !== undefined) {
      line(`      ${s.gray!('expected:')} ${s.green!(show(error.expected))}`)
      line(`      ${s.gray!('actual:  ')} ${s.red!(show(error.actual))}`)
    }
  }

  return (event: RunEvent): void => {
    switch (event.type) {
      case 'run-start': {
        line()
        line(s.bold!('PWS Conformance Suite'))
        line(`${s.gray!('server:')} ${serverUrl}`)
        line(
          `${s.gray!('running')} ${event.testCount} ${s.gray!(
            `test(s) across ${event.suiteCount} suite(s)`
          )}`
        )
        break
      }
      case 'suite-start': {
        line()
        const tag = event.optional ? s.gray!(' (optional)') : ''
        line(s.bold!(event.name) + tag)
        break
      }
      case 'test-end': {
        const r = event.result
        const label = r.status === 'skip' ? s.gray!(r.name) : r.name
        let extra = ''
        if (r.status === 'skip' && r.skipReason) {
          extra = ` ${s.gray!(`(${r.skipReason})`)}`
        }
        line(`  ${glyphFor(r)} ${label}${extra}`)
        if (r.status === 'fail' && r.error) {
          printError(r.error, r.optional && !includeOptional)
        }
        break
      }
      case 'suite-end': {
        if (event.result.teardownError) {
          line(
            `  ${s.yellow!('⚠')} ${s.gray!(
              `teardown: ${event.result.teardownError}`
            )}`
          )
        }
        break
      }
      case 'run-end': {
        printSummary(event.report.suites)
        const c = event.report.counts
        const realFail = includeOptional ? c.fail : c.fail - c.optionalFail
        line()
        const parts = [
          s.green!(`${c.pass} passed`),
          realFail > 0 ? s.red!(`${realFail} failed`) : `${realFail} failed`,
          c.skip > 0 ? s.gray!(`${c.skip} skipped`) : `${c.skip} skipped`
        ]
        if (!includeOptional && c.optionalFail > 0) {
          parts.push(s.yellow!(`${c.optionalFail} optional failing`))
        }
        line(parts.join(s.gray!('  |  ')))
        line(
          `${s.gray!('total')} ${c.total} ${s.gray!('in')} ${formatMs(
            event.report.durationMs
          )}`
        )
        const conformant = includeOptional
          ? c.fail === 0
          : event.report.conformant
        line()
        line(
          conformant
            ? s.green!(s.bold!('CONFORMANT'))
            : s.red!(s.bold!('NON-CONFORMANT'))
        )
        break
      }
      default:
        break
    }
  }

  /** Prints the aligned per-suite counts table. */
  function printSummary(suiteResults: SuiteResult[]): void {
    line()
    line(s.bold!('Summary'))
    const nameWidth = Math.max(5, ...suiteResults.map(r => r.name.length))
    const pad = (text: string, width: number): string =>
      text + ' '.repeat(Math.max(0, width - text.length))
    for (const r of suiteResults) {
      const c = r.counts
      const optFail = c.optionalFail
      const hardFail = c.fail - optFail
      const cells = [
        s.green!(`${c.pass} pass`),
        hardFail > 0 ? s.red!(`${hardFail} fail`) : `${hardFail} fail`,
        c.skip > 0 ? s.gray!(`${c.skip} skip`) : `${c.skip} skip`
      ]
      if (optFail > 0) {
        cells.push(s.yellow!(`${optFail} opt-fail`))
      }
      line(`  ${pad(r.name, nameWidth)}  ${cells.join('  ')}`)
    }
  }
}

/** Formats a duration in ms as `1.2s` past a second, else `850ms`. */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
