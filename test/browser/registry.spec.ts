import { test, expect } from '@playwright/test'

import { suites } from '../../src/suites/index.js'

/**
 * Browser-compat smoke: importing the library in a browser pulls in the whole
 * suite registry and its dependency stack (pws-client incl. tar handling,
 * ezcap, ed25519 packages, bnid). `createContext` additionally exercises
 * deterministic did:key generation in the browser.
 */
test('suite registry loads and context builds in the browser', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', err => errors.push(err.message))
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    const { suites, createContext } = await import('/src/index.ts')
    const ctx = await createContext({ serverUrl: 'http://localhost:9' })
    return {
      suiteIds: suites.map((s: { id: string }) => s.id),
      aliceDid: ctx.actors.alice.did,
      generatedId: ctx.generateId()
    }
  })
  // Compare against the registry as Node sees it, so a suite that fails to
  // load in the browser build shows up without hardcoding the count here.
  expect(result.suiteIds).toEqual(suites.map(s => s.id))
  expect(result.suiteIds).toContain('spaces-api')
  // Deterministic seed: the did:key is stable across environments.
  expect(result.aliceDid).toMatch(/^did:key:z6Mk/)
  expect(result.generatedId).toMatch(/^[0-9a-f-]{36}$/)
  expect(errors).toEqual([])
})
