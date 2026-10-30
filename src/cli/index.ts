#!/usr/bin/env node
/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `pws-conformance` bin entry: reads the tool and client versions from the
 * installed packages, binds real process I/O, and delegates to the testable
 * `main()`. All logic lives in `./main.js`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from '../index.js'
import { suites } from '../suites/index.js'
import { main } from './main.js'

/** Reads this tool's own version from its package.json (../../ from dist/cli). */
function readToolVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../package.json'
    )
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Best-effort `@interop/pws-client` version: its package.json is not exported,
 * so resolve the entry module and walk up to the owning package manifest.
 */
function readClientVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    let dir = dirname(require.resolve('@interop/pws-client'))
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@interop/pws-client') {
          return pkg.version
        }
      } catch {
        // Keep walking up to the package root.
      }
      const parent = dirname(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
  } catch {
    // No client version available; the JSON reporter simply omits it.
  }
  return undefined
}

const exitCode = await main(process.argv.slice(2), {
  runConformance,
  suites,
  fetch: globalThis.fetch,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  version: readToolVersion(),
  clientVersion: readClientVersion()
})

process.exitCode = exitCode
