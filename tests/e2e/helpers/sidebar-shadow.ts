import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/** Whether out/ holds an ORCA_SIDEBAR_INPUTS=main build (config/dark-build-switches.cjs marks it). */
export const SIDEBAR_INPUTS_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_SIDEBAR_INPUTS_MAIN')
)

/**
 * Main's sidebar inputs agree with what the window derives itself (dev/test shadow mode). Without
 * an ORCA_SIDEBAR_INPUTS=main build there is nothing to compare, and no comparison may run.
 */
export async function expectNoSidebarShadowMismatches(page: Page): Promise<void> {
  if (!SIDEBAR_INPUTS_BUILD) {
    expect(await page.evaluate(() => window.__sidebarShadow === undefined)).toBe(true)
    return
  }
  const comparisons = (): Promise<number> =>
    page.evaluate(() => window.__sidebarShadow?.comparisons() ?? -1)
  const start = await comparisons()
  // Two fresh comparisons: a disagreement is recorded once it holds across a whole interval.
  await expect
    .poll(comparisons, { timeout: 15_000, message: 'main never answered a shadow comparison' })
    .toBeGreaterThanOrEqual(Math.max(start, 0) + 2)
  const mismatches = await page.evaluate(() => window.__sidebarShadow?.mismatches() ?? [])
  expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([])
}
