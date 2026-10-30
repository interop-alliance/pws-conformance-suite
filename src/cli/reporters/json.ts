/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The CI reporter: it buffers events and, at run-end, writes one structured
 * JSON document to stdout (and nothing else -- any human chatter goes to
 * stderr). The document wraps the full `RunReport` with tool metadata and the
 * server URL.
 */
import type { RunEvent } from '../../harness/types.js'

/**
 * Creates a JSON reporter. Only the final `run-end` event produces stdout
 * output, keeping stdout a single valid JSON document for machine consumers.
 *
 * @param options {object}
 * @param options.write {Function} stdout sink
 * @param options.writeErr {Function} stderr sink (reserved for diagnostics)
 * @param options.tool {object} tool name/version metadata
 * @param options.serverUrl {string} target URL
 * @returns {(event: RunEvent) => void}
 */
export function createJsonReporter({
  write,
  writeErr: _writeErr,
  tool,
  serverUrl
}: {
  write: (text: string) => void
  writeErr: (text: string) => void
  tool: { name: string; version: string; clientVersion?: string }
  serverUrl: string
}): (event: RunEvent) => void {
  return (event: RunEvent): void => {
    if (event.type !== 'run-end') {
      return
    }
    const { report } = event
    const document = {
      tool,
      serverUrl,
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      conformant: report.conformant,
      counts: report.counts,
      suites: report.suites
    }
    write(JSON.stringify(document, null, 2) + '\n')
  }
}
