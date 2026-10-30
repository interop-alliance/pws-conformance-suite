import { test, expect } from '@playwright/test'

import { suites } from '../../src/suites/index.js'

/**
 * E2e for the web app (served by the repo-root Vite dev server at
 * /web/index.html). The first three tests are server-free: they exercise the
 * form, its validation, and the CORS/unreachable preflight diagnosis. The
 * final full-loop test runs the real suite against a live WAS server and is
 * skipped unless TEST_SERVER_URL is set (byte-identical-URL constraint: pass
 * the exact URL the server was started with).
 */
const APP = '/web/index.html'

test('setup form renders the suite registry and prefills ?server=', async ({
  page
}) => {
  await page.goto(`${APP}?server=http://localhost:3002`)
  await expect(page.getByTestId('setup-screen')).toBeVisible()
  await expect(page.getByTestId('server-url')).toHaveValue(
    'http://localhost:3002'
  )
  await expect(page.getByTestId('token')).toHaveAttribute('type', 'password')
  // Full registry, all selected by default.
  const checkboxes = page
    .getByTestId('suite-select')
    .locator('input[type="checkbox"]')
  await expect(checkboxes).toHaveCount(suites.length)
  for (const box of await checkboxes.all()) {
    await expect(box).toBeChecked()
  }
  await expect(page.getByTestId('suite-checkbox-spaces-api')).toBeChecked()
  // Default optional-test handling is warn.
  await expect(
    page.getByTestId('optional-mode').locator('input[value="warn"]')
  ).toBeChecked()
})

for (const url of ['not a url', 'http://127.0.0.1:9/?']) {
  test(`server URL "${url}" shows a form error and stays on the form`, async ({
    page
  }) => {
    await page.goto(APP)
    await page.getByTestId('server-url').fill(url)
    await page.getByTestId('run-button').click()
    await expect(page.getByTestId('form-error')).toBeVisible()
    await expect(page.getByTestId('setup-screen')).toBeVisible()
  })
}

test('an unreachable server shows the network/CORS diagnosis', async ({
  page
}) => {
  await page.goto(APP)
  // Port 9 (discard) refuses immediately; the preflight probe fails without
  // waiting for its full 10s timeout.
  await page.getByTestId('server-url').fill('http://127.0.0.1:9/')
  await page.getByTestId('run-button').click()
  await expect(page.getByTestId('preflight-error')).toBeVisible({
    timeout: 20_000
  })
  await expect(page.getByTestId('preflight-error')).toContainText(/CORS/i)
  // The diagnosis points at the CORS-free alternative.
  await expect(page.getByTestId('preflight-error')).toContainText(
    /pws-conformance/
  )
  // No suites ran.
  await expect(page.getByTestId('test-row')).toHaveCount(0)
  // Back returns to the form.
  await page.getByTestId('back-button').click()
  await expect(page.getByTestId('setup-screen')).toBeVisible()
})

test('full conformance run against a live server renders a verdict', async ({
  page
}) => {
  const serverUrl = process.env.TEST_SERVER_URL
  test.skip(!serverUrl, 'TEST_SERVER_URL not set')
  // Sequential suite over HTTP: allow plenty of time.
  test.setTimeout(900_000)
  await page.goto(APP)
  await page.getByTestId('server-url').fill(serverUrl!)
  const token = process.env.TEST_ONBOARDING_TOKEN
  if (token) {
    await page.getByTestId('token').fill(token)
  }
  await page.getByTestId('run-button').click()
  await expect(page.getByTestId('run-screen')).toBeVisible()
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 880_000 })
  await expect(page.getByTestId('verdict')).toHaveAttribute(
    'data-conformant',
    'true'
  )
  // Live rendering produced per-test rows and a green summary.
  expect(await page.getByTestId('test-row').count()).toBeGreaterThan(0)
  await expect(page.getByTestId('count-fail')).toHaveText('0')
  // The report buttons are live at run-end.
  await expect(page.getByTestId('download-json')).toBeEnabled()
  await expect(page.getByTestId('copy-json')).toBeEnabled()
})
