/**
 * Read-side probes for one split's browser guest: its URL, zoom, and how many loads it started.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

function guestSelector(browserTabId: string): string {
  return `[data-browser-overlay-tab-id="${browserTabId}"] webview`
}

export async function guestUrl(page: Page, browserTabId: string): Promise<string | null> {
  return page.evaluate((selector) => {
    const webview = document.querySelector<Electron.WebviewTag>(selector)
    try {
      return webview?.getURL() ?? null
    } catch {
      return null
    }
  }, guestSelector(browserTabId))
}

export async function guestZoomLevel(page: Page, browserTabId: string): Promise<number | null> {
  return page.evaluate((selector) => {
    const webview = document.querySelector<Electron.WebviewTag>(selector)
    try {
      return webview?.getZoomLevel() ?? null
    } catch {
      return null
    }
  }, guestSelector(browserTabId))
}

export async function waitForGuestUrl(
  page: Page,
  browserTabId: string,
  expectedUrl: string
): Promise<void> {
  await expect.poll(() => guestUrl(page, browserTabId), { timeout: 20_000 }).toBe(expectedUrl)
}

/** Navigates the guest the way a link click does, so it gains a real history entry. */
export async function navigateGuest(page: Page, browserTabId: string, url: string): Promise<void> {
  await page.evaluate(
    ({ selector, targetUrl }) => {
      const webview = document.querySelector<Electron.WebviewTag>(selector)
      if (!webview) {
        throw new Error('Browser guest unavailable')
      }
      // Why: without a user gesture Chromium marks the prior entry skippable and Back jumps over it.
      void webview.executeJavaScript(`location.href = ${JSON.stringify(targetUrl)}`, true)
    },
    { selector: guestSelector(browserTabId), targetUrl: url }
  )
  await waitForGuestUrl(page, browserTabId, url)
}

/**
 * Counts `did-start-loading` on the guest element from now on. A load start fires as soon as a
 * stray goBack/reload is issued, so a zero count is not waiting on a slow page to finish.
 */
export async function recordGuestLoadStarts(page: Page, browserTabIds: string[]): Promise<void> {
  await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const webview = document.querySelector<Electron.WebviewTag>(selector)
      if (!webview) {
        throw new Error('Browser guest unavailable')
      }
      webview.dataset.e2eLoadStarts = '0'
      if (webview.dataset.e2eLoadStartsRecording === 'true') {
        continue
      }
      webview.dataset.e2eLoadStartsRecording = 'true'
      webview.addEventListener('did-start-loading', () => {
        webview.dataset.e2eLoadStarts = String(Number(webview.dataset.e2eLoadStarts ?? '0') + 1)
      })
    }
  }, browserTabIds.map(guestSelector))
}

export async function guestLoadStarts(page: Page, browserTabId: string): Promise<number> {
  return page.evaluate(
    (selector) =>
      Number(document.querySelector<HTMLElement>(selector)?.dataset.e2eLoadStarts ?? 'NaN'),
    guestSelector(browserTabId)
  )
}

/** Waits for the guest to finish loading so a stray load in a sibling guest has had its turn. */
export async function waitForGuestIdle(page: Page, browserTabId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const webview = document.querySelector<Electron.WebviewTag>(selector)
        try {
          return webview ? !webview.isLoading() : false
        } catch {
          return false
        }
      }, guestSelector(browserTabId))
    )
    .toBe(true)
}
