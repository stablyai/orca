/**
 * Shared drivers for the terminal pane title strip: opening the pane context
 * menu and committing a Set Title value through it.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function setPaneTitleFromTerminalMenu(page: Page, title: string): Promise<void> {
  await openTerminalContextMenu(page)
  await page.getByText('Set Title…', { exact: true }).click()
  const titleInput = page.locator('.pane-title-input').first()
  await expect(titleInput).toBeVisible()
  await titleInput.fill(title)
  await titleInput.press('Enter')
  // Why: CI can dispatch Enter before React has committed the filled value;
  // blurring exercises the same submit path and makes the helper deterministic.
  try {
    await expect(titleInput).toHaveCount(0, { timeout: 500 })
  } catch {
    await titleInput.evaluateAll(([input]) => (input as HTMLElement | undefined)?.blur())
  }
  await expect(titleInput).toHaveCount(0)
}

export async function openTerminalContextMenu(page: Page): Promise<void> {
  const modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[] = (await page.evaluate(() =>
    navigator.userAgent.includes('Windows')
  ))
    ? ['Control']
    : []
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  await page
    .locator('.xterm:visible')
    .first()
    .click({
      button: isMac ? 'left' : 'right',
      position: { x: 40, y: 40 },
      modifiers: isMac ? ['Control'] : modifiers
    })
  await expect(page.getByText('Set Title…', { exact: true })).toBeVisible()
}
