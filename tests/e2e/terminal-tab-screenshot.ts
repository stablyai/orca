import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'

function tabScreenLocator(page: Page, tabId: string): ReturnType<Page['locator']> {
  return page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-screen`).first()
}

export async function captureStableTabScreenshot(page: Page, tabId: string): Promise<Buffer> {
  const screen = tabScreenLocator(page, tabId)
  await expect(screen).toBeVisible()
  let previous = await screen.screenshot({ animations: 'disabled' })
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(250)
    const next = await screen.screenshot({ animations: 'disabled' })
    if (next.equals(previous)) {
      return next
    }
    previous = next
  }
  throw new Error(`Terminal surface for tab ${tabId} did not stabilize for screenshot`)
}
