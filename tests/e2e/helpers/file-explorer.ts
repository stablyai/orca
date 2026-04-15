import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { pressShortcut } from './shortcuts'

/** Open the right sidebar file explorer and wait for it to be ready. */
export async function openFileExplorer(page: Page): Promise<void> {
  await pressShortcut(page, 'e', { shift: true })
  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__store?.getState().rightSidebarOpen),
      { timeout: 3_000 }
    )
    .toBe(true)
  await page
    .locator('[data-native-file-drop-target="file-explorer"]')
    .waitFor({ state: 'visible', timeout: 5_000 })
}

/**
 * Click the first visible matching file in the explorer.
 *
 * Why: the seeded E2E repo keeps a few stable root-level files visible without
 * scrolling, so the test can exercise the real explorer click path instead of
 * bypassing it through store actions.
 */
export async function clickFileInExplorer(
  page: Page,
  candidates: string[]
): Promise<string | null> {
  for (const fileName of candidates) {
    const fileRow = page.getByText(fileName, { exact: true }).first()
    const isVisible = await fileRow.isVisible({ timeout: 1_000 }).catch(() => false)
    if (!isVisible) {
      continue
    }
    await fileRow.click()
    return fileName
  }
  return null
}
