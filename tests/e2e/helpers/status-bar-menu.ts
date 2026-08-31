import type { Page } from '@stablyai/playwright-test'

/** Wait for composer autofocus, which closes non-modal status menus opened too early. */
export async function waitForStartupFocusToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, {
      timeout: 15_000
    })
    .catch(() => {
      // No composer on this screen; nothing will steal focus.
    })
}
