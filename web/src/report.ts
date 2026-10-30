/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * App-side pure helpers: suite selection/shaping and building the JSON report
 * document. These mirror the CLI's behavior (`selectSuites` and the JSON
 * reporter's document shape) but are reimplemented here because the CLI
 * internals are Node-only and not exported.
 */
import type { RunReport, Suite } from '../../src/index.js'

/**
 * Restricts the registry to the checked suite ids and, under `skipOptional`,
 * drops optional tests (and suites whose `optional` flag marks everything
 * optional), dropping any suite left with no tests. Mirrors the CLI's
 * `selectSuites` for the subset of shaping the web form exposes.
 *
 * @param registry {Suite[]} the full available registry
 * @param options {object}
 * @param options.suiteIds {string[]} the checked suite ids to keep
 * @param options.skipOptional {boolean} drop optional tests entirely
 * @returns {Suite[]}
 */
export function selectSuites(
  registry: Array<Suite<any>>,
  { suiteIds, skipOptional }: { suiteIds: string[]; skipOptional: boolean }
): Array<Suite<any>> {
  const wanted = new Set(suiteIds)
  const selected = registry.filter(s => wanted.has(s.id))
  if (!skipOptional) {
    return selected
  }
  return selected
    .map(suite => {
      const suiteOptional = suite.optional ?? false
      const tests = suite.tests.filter(
        test => !(suiteOptional || (test.optional ?? false))
      )
      return { ...suite, tests }
    })
    .filter(suite => suite.tests.length > 0)
}

/**
 * Builds the report document, byte-shape-identical to the CLI json reporter's
 * output (minus the Node-only `clientVersion` tool field), pretty-printed with
 * a 2-space indent.
 *
 * @param options {object}
 * @param options.version {string} this tool's version
 * @param options.serverUrl {string} the target URL
 * @param options.report {RunReport} the completed run report
 * @returns {string} the pretty-printed JSON document
 */
export function buildReportJson({
  version,
  serverUrl,
  report
}: {
  version: string
  serverUrl: string
  report: RunReport
}): string {
  const document = {
    tool: { name: 'pws-conformance', version },
    serverUrl,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    conformant: report.conformant,
    counts: report.counts,
    suites: report.suites
  }
  return JSON.stringify(document, null, 2)
}

/** Formats a duration in ms as `1.2s` past a second, else `850ms`. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
