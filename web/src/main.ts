/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The WAS conformance web app: a dependency-free, two-screen vanilla-TS UI that
 * runs the identical conformance suite fully client-side (the `@interop` stack
 * is isomorphic and talks over `fetch`). Screen 1 is the setup form; screen 2
 * is the live run view. The onboarding token stays in the browser and is only
 * ever sent to the target server; the server URL alone may be shared via a
 * `?server=` query param.
 */
import { runConformance, suites } from '../../src/index.js'
import pkg from '../../package.json'
import { buildReportJson, formatMs, redactUrl, selectSuites } from './report.js'
import { el, runningRow, testRow } from './view.js'
import type { RunEvent, RunReport } from '../../src/index.js'
import './app.css'

const TOKEN_KEY = 'pws-conformance:token'
type OptionalMode = 'warn' | 'include' | 'skip'

/** Convenience typed lookup by the app's `data-testid` contract. */
function q<T extends HTMLElement = HTMLElement>(testid: string): T {
  const node = document.querySelector<T>(`[data-testid="${testid}"]`)
  if (!node) {
    throw new Error(`missing element: ${testid}`)
  }
  return node
}

/** Renders the whole page shell (both screens) into `#app`. */
function render(): void {
  const app = document.querySelector<HTMLElement>('#app')
  if (!app) {
    throw new Error('missing #app root')
  }
  app.append(setupScreen(), runScreen())
}

/** Builds the setup form screen. */
function setupScreen(): HTMLElement {
  const suiteList = el('div', {
    class: 'suite-list',
    dataset: { testid: 'suite-select' }
  })
  const toggles = el('div', { class: 'suite-toggles' }, [
    el('button', {
      class: 'link-button',
      type: 'button',
      text: 'all',
      onclick: () => setAllSuites(true)
    }),
    el('button', {
      class: 'link-button',
      type: 'button',
      text: 'none',
      onclick: () => setAllSuites(false)
    })
  ])
  suiteList.append(toggles)
  for (const suite of suites) {
    const checkbox = el('input', {
      type: 'checkbox',
      checked: true,
      dataset: { testid: `suite-checkbox-${suite.id}` },
      value: suite.id
    })
    suiteList.append(
      el('label', { class: 'suite-item' }, [
        checkbox,
        el('span', { class: 'suite-name', text: suite.name }),
        el('code', { class: 'suite-id', text: suite.id })
      ])
    )
  }

  const form = el('form', { noValidate: true, class: 'setup-form' }, [
    field('Server URL', {
      class: 'mono',
      type: 'url',
      placeholder: 'https://was.example.com',
      dataset: { testid: 'server-url' }
    }),
    field('Onboarding token', {
      class: 'mono',
      type: 'password',
      dataset: { testid: 'token' }
    }),
    el('p', {
      class: 'hint',
      text: 'Optional. The token never leaves this browser except in requests to the target server.'
    }),
    el('label', { class: 'checkbox-row' }, [
      el('input', { type: 'checkbox', dataset: { testid: 'remember-token' } }),
      el('span', { text: 'Remember token for this tab' })
    ]),
    optionalModeFieldset(),
    el('p', { class: 'field-label', text: 'Suites' }),
    suiteList,
    el('p', {
      class: 'form-error',
      dataset: { testid: 'form-error' },
      hidden: true
    }),
    el('button', {
      class: 'run-button',
      type: 'submit',
      text: 'Run conformance tests',
      dataset: { testid: 'run-button' }
    })
  ])
  form.addEventListener('submit', onSubmit)

  return el('section', { dataset: { testid: 'setup-screen' } }, [
    el('h1', { text: 'WAS Conformance Suite' }),
    form
  ])
}

/** A labeled text input row. */
function field(label: string, inputProps: Record<string, any>): HTMLElement {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label }),
    el('input', inputProps)
  ])
}

/** The optional-test-handling radio group. */
function optionalModeFieldset(): HTMLElement {
  const modes: Array<{
    value: OptionalMode
    label: string
    checked?: boolean
  }> = [
    {
      value: 'warn',
      label: 'Run optional tests, report failures as warnings',
      checked: true
    },
    { value: 'include', label: 'Treat optional tests as required' },
    { value: 'skip', label: 'Do not run optional tests' }
  ]
  const fieldset = el('fieldset', {
    class: 'optional-mode',
    dataset: { testid: 'optional-mode' }
  })
  fieldset.append(el('legend', { text: 'Optional tests' }))
  for (const mode of modes) {
    fieldset.append(
      el('label', { class: 'radio-row' }, [
        el('input', {
          type: 'radio',
          name: 'optional-mode',
          value: mode.value,
          checked: mode.checked ?? false
        }),
        el('span', { text: mode.label })
      ])
    )
  }
  return fieldset
}

/** Builds the (initially hidden) run view screen. */
function runScreen(): HTMLElement {
  const summary = el(
    'header',
    { class: 'summary', dataset: { testid: 'summary' } },
    [
      el('code', {
        class: 'summary-server',
        dataset: { testid: 'summary-server' }
      }),
      el('div', { class: 'counts' }, [
        el('span', {
          class: 'count count-pass',
          dataset: { testid: 'count-pass' },
          text: '0'
        }),
        el('span', {
          class: 'count count-fail',
          dataset: { testid: 'count-fail' },
          text: '0'
        }),
        el('span', {
          class: 'count count-skip',
          dataset: { testid: 'count-skip' },
          text: '0'
        }),
        el('span', {
          class: 'count duration',
          dataset: { testid: 'duration' },
          text: '0ms'
        })
      ]),
      el('button', {
        class: 'back-button',
        type: 'button',
        text: 'New run',
        dataset: { testid: 'back-button' },
        onclick: toSetup
      })
    ]
  )

  const actions = el('div', { class: 'report-actions' }, [
    el('button', {
      type: 'button',
      text: 'Copy JSON',
      disabled: true,
      dataset: { testid: 'copy-json' },
      onclick: onCopyJson
    }),
    el('button', {
      type: 'button',
      text: 'Download JSON',
      disabled: true,
      dataset: { testid: 'download-json' },
      onclick: onDownloadJson
    })
  ])

  return el('section', { dataset: { testid: 'run-screen' }, hidden: true }, [
    summary,
    el('div', {
      class: 'preflight-error',
      dataset: { testid: 'preflight-error' },
      hidden: true
    }),
    el('div', {
      class: 'verdict',
      dataset: { testid: 'verdict' },
      hidden: true
    }),
    actions,
    el('div', { class: 'results', dataset: { testid: 'results' } })
  ])
}

// --- Run state -------------------------------------------------------------

let running = false
let ticker: ReturnType<typeof setInterval> | null = null
let reportJson: string | null = null
const rows = new Map<string, HTMLElement>()
const groups = new Map<string, HTMLElement>()
const counts = { pass: 0, fail: 0, skip: 0 }

/** Checks/unchecks every suite checkbox. */
function setAllSuites(checked: boolean): void {
  for (const suite of suites) {
    const box = q<HTMLInputElement>(`suite-checkbox-${suite.id}`)
    box.checked = checked
  }
}

/** The optional-mode selected in the radio group. */
function selectedOptionalMode(): OptionalMode {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="optional-mode"]:checked'
  )
  return (checked?.value as OptionalMode) ?? 'warn'
}

/** Form submit: validate, persist the token choice, and start the run. */
function onSubmit(event: SubmitEvent): void {
  event.preventDefault()
  if (running) {
    return
  }
  const formError = q('form-error')
  // Validate but never normalize: ZCap invocationTarget URLs must match the
  // server URL byte-for-byte, and `new URL().toString()` appends a trailing
  // slash that would break every URL-shape assertion.
  const serverUrl = q<HTMLInputElement>('server-url').value.trim()
  try {
    new URL(serverUrl)
  } catch {
    return showFormError(formError, 'Enter a valid server URL.')
  }

  const suiteIds = suites
    .map(s => s.id)
    .filter(id => q<HTMLInputElement>(`suite-checkbox-${id}`).checked)
  if (suiteIds.length === 0) {
    return showFormError(formError, 'Select at least one suite to run.')
  }
  formError.hidden = true

  const token = q<HTMLInputElement>('token').value
  const remember = q<HTMLInputElement>('remember-token').checked
  if (remember && token) {
    sessionStorage.setItem(TOKEN_KEY, token)
  } else {
    sessionStorage.removeItem(TOKEN_KEY)
  }

  void startRun({
    serverUrl,
    token: token || null,
    suiteIds,
    optionalMode: selectedOptionalMode()
  })
}

/** Shows an inline form error and keeps the user on the setup screen. */
function showFormError(node: HTMLElement, message: string): void {
  node.textContent = message
  node.hidden = false
}

/** Switches to the run screen, preflights, then streams the live run. */
async function startRun({
  serverUrl,
  token,
  suiteIds,
  optionalMode
}: {
  serverUrl: string
  token: string | null
  suiteIds: string[]
  optionalMode: OptionalMode
}): Promise<void> {
  resetRunScreen(serverUrl)
  setRunning(true)
  showScreen('run')

  if (!(await isReachable(serverUrl))) {
    showPreflightError(
      `Server unreachable from a browser: a network error or missing CORS ` +
        `support. If the server is running, it may not send CORS headers; the ` +
        `CLI has no CORS constraint: npx @interop/pws-conformance-suite ` +
        redactUrl(serverUrl)
    )
    setRunning(false)
    return
  }

  const selected = selectSuites(suites, {
    suiteIds,
    skipOptional: optionalMode === 'skip'
  })

  startTicker()
  let report: RunReport
  try {
    report = await runConformance({
      serverUrl,
      onboardingToken: token,
      suites: selected,
      onEvent: event => onEvent(event, optionalMode)
    })
  } catch (err) {
    stopTicker()
    showPreflightError(
      `Could not run the suite: ${err instanceof Error ? err.message : String(err)}`
    )
    setRunning(false)
    return
  }

  stopTicker()
  finishRun(report, optionalMode, serverUrl)
  setRunning(false)
}

/** Best-effort connectivity probe; any resolved response counts as reachable. */
async function isReachable(serverUrl: string): Promise<boolean> {
  try {
    await fetch(new URL(serverUrl), {
      method: 'GET',
      signal: AbortSignal.timeout(10_000)
    })
    return true
  } catch {
    return false
  }
}

/** Renders one live run event into the results area and updates the counts. */
function onEvent(event: RunEvent, optionalMode: OptionalMode): void {
  switch (event.type) {
    case 'suite-start': {
      const group = el(
        'section',
        {
          class: 'suite-group',
          dataset: { testid: `suite-group-${event.suiteId}` }
        },
        [el('h2', { class: 'suite-heading', text: event.name })]
      )
      groups.set(event.suiteId, group)
      q('results').append(group)
      break
    }
    case 'test-start': {
      const key = `${event.suiteId}:${event.testId}`
      const row = runningRow({ name: event.name, group: event.group })
      rows.set(key, row)
      groups.get(event.suiteId)?.append(row)
      break
    }
    case 'test-end': {
      const r = event.result
      counts[r.status] += 1
      renderCounts()
      const warn = r.optional && optionalMode !== 'include'
      const finished = testRow(r, { warn })
      const key = `${r.suiteId}:${r.testId}`
      const placeholder = rows.get(key)
      if (placeholder) {
        placeholder.replaceWith(finished)
      } else {
        groups.get(r.suiteId)?.append(finished)
      }
      rows.set(key, finished)
      break
    }
    case 'suite-end': {
      if (event.result.teardownError) {
        groups.get(event.result.suiteId)?.append(
          el('p', {
            class: 'teardown-note',
            text: `teardown: ${event.result.teardownError}`
          })
        )
      }
      break
    }
    default:
      break
  }
}

/** Applies final counts and the verdict banner, and enables the report buttons. */
function finishRun(
  report: RunReport,
  optionalMode: OptionalMode,
  serverUrl: string
): void {
  const c = report.counts
  counts.pass = c.pass
  counts.fail = c.fail
  counts.skip = c.skip
  renderCounts()
  q('duration').textContent = formatMs(report.durationMs)

  const requiredFail =
    optionalMode === 'include' ? c.fail : c.fail - c.optionalFail
  const optionalWarn = optionalMode === 'include' ? 0 : c.optionalFail
  const conformant =
    optionalMode === 'include' ? c.fail === 0 : report.conformant

  const verdict = q('verdict')
  verdict.dataset.conformant = String(conformant)
  verdict.replaceChildren()
  verdict.append(
    el('span', {
      class: 'verdict-main',
      text: conformant ? 'Conformant' : `${requiredFail} conformance failure(s)`
    })
  )
  if (optionalWarn > 0) {
    verdict.append(
      el('span', {
        class: 'verdict-warn',
        text: `${optionalWarn} optional-test warning(s)`
      })
    )
  }
  verdict.hidden = false

  reportJson = buildReportJson({
    version: pkg.version,
    serverUrl: redactUrl(serverUrl),
    report
  })
  q<HTMLButtonElement>('copy-json').disabled = false
  q<HTMLButtonElement>('download-json').disabled = false
}

/** Writes the live pass/fail/skip counts into the sticky header. */
function renderCounts(): void {
  q('count-pass').textContent = String(counts.pass)
  q('count-fail').textContent = String(counts.fail)
  q('count-skip').textContent = String(counts.skip)
}

/** Resets the run screen to a clean pre-run state for the given target. */
function resetRunScreen(serverUrl: string): void {
  rows.clear()
  groups.clear()
  counts.pass = 0
  counts.fail = 0
  counts.skip = 0
  reportJson = null
  renderCounts()
  q('duration').textContent = '0ms'
  q('summary-server').textContent = redactUrl(serverUrl)
  q('results').replaceChildren()
  const preflight = q('preflight-error')
  preflight.hidden = true
  preflight.textContent = ''
  const verdict = q('verdict')
  verdict.hidden = true
  verdict.replaceChildren()
  q<HTMLButtonElement>('copy-json').disabled = true
  q<HTMLButtonElement>('download-json').disabled = true
}

/** Shows the browser-unreachable / run-failure diagnosis box. */
function showPreflightError(message: string): void {
  const box = q('preflight-error')
  box.textContent = message
  box.hidden = false
}

/** Toggles the running lock: disables navigation/run controls while a run runs. */
function setRunning(value: boolean): void {
  running = value
  q<HTMLButtonElement>('run-button').disabled = value
  q<HTMLButtonElement>('back-button').disabled = value
}

/** Starts the elapsed-time ticker. */
function startTicker(): void {
  const startedAt = performance.now()
  q('duration').textContent = '0ms'
  ticker = setInterval(() => {
    q('duration').textContent = formatMs(performance.now() - startedAt)
  }, 100)
}

/** Stops the elapsed-time ticker. */
function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

/** Copies the report JSON to the clipboard. */
async function onCopyJson(): Promise<void> {
  if (reportJson) {
    await navigator.clipboard.writeText(reportJson)
  }
}

/** Downloads the report JSON as a file. */
function onDownloadJson(): void {
  if (!reportJson) {
    return
  }
  const blob = new Blob([reportJson], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = el('a', {
    href: url,
    download: 'pws-conformance-report.json'
  }) as HTMLAnchorElement
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Returns to the setup screen (only reachable when not running). */
function toSetup(): void {
  if (running) {
    return
  }
  showScreen('setup')
}

/** Shows one screen and hides the other. */
function showScreen(which: 'setup' | 'run'): void {
  q('setup-screen').hidden = which !== 'setup'
  q('run-screen').hidden = which !== 'run'
}

/** Prefills the server URL from `?server=` and restores a remembered token. */
function hydrate(): void {
  const server = new URLSearchParams(location.search).get('server')
  if (server) {
    q<HTMLInputElement>('server-url').value = server
  }
  const token = sessionStorage.getItem(TOKEN_KEY)
  if (token) {
    q<HTMLInputElement>('token').value = token
    q<HTMLInputElement>('remember-token').checked = true
  }
}

render()
hydrate()
