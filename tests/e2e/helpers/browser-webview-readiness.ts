import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function waitForBrowserWebview(
  page: Page,
  browserTabId: string,
  timeout = 5_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
            (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === id
          )
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          if (!webview) {
            return false
          }
          try {
            return webview.getWebContentsId() > 0
          } catch (error) {
            if (error instanceof Error && error.message.includes('dom-ready event emitted')) {
              return false
            }
            throw error
          }
        }, browserTabId),
      { timeout }
    )
    .toBe(true)
}
