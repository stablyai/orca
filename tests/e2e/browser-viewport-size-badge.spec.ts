/**
 * E2E for issue #31014: resizing the browser pane flashes the page's viewport
 * size in the top-right badge, and the number matches what the page itself
 * reports as innerWidth × innerHeight under page zoom and Orca UI zoom.
 */

import { createServer } from 'node:http'
import { expect, test } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  getActiveTabType,
  getActiveWorktreeId,
  getBrowserTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

const WINDOW_HEIGHT = 800

async function startPageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Viewport</title></head><body>ok</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Page server has no TCP address')
  }
  return {
    url: `http://127.0.0.1:${address.port}/viewport`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function setWindowWidth(electronApp: ElectronApplication, width: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('No Electron window')
      }
      window.setMinimumSize(0, 0)
      window.setSize(size.width, size.height)
    },
    { width, height: WINDOW_HEIGHT }
  )
}

/** Same path as Settings' UI zoom: the renderer's webFrame zoom. */
async function setUiZoomLevel(page: Page, level: number): Promise<void> {
  await page.evaluate((zoomLevel) => window.api.ui.setZoomLevel(zoomLevel), level)
}

async function guestViewportSize(
  electronApp: ElectronApplication,
  guestUrl: string
): Promise<string | null> {
  // Why main process: the guest webview is reparented into a slot outside the pane's DOM subtree.
  return electronApp.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url)
    if (!guest || guest.isDestroyed() || guest.isLoading()) {
      return null
    }
    try {
      const size: [number, number] = await guest.executeJavaScript('[innerWidth, innerHeight]')
      return `${size[0]} × ${size[1]}`
    } catch {
      return null
    }
  }, guestUrl)
}

/** Counts every size flash in the renderer, so a flash that fades before an assertion still counts. */
async function startCountingSizeFlashes(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.dataset.sizeBadgeFlashes = '0'
    new MutationObserver(() => {
      const shown = document.querySelector(
        '[data-browser-page-viewport-id] [role="status"][aria-hidden="false"]'
      )
      const label = shown?.textContent ?? ''
      if (label.includes('×') && label !== document.body.dataset.sizeBadgeLastLabel) {
        document.body.dataset.sizeBadgeFlashes = String(
          Number(document.body.dataset.sizeBadgeFlashes) + 1
        )
      }
      document.body.dataset.sizeBadgeLastLabel = label
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-hidden']
    })
  })
}

async function sizeFlashCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.body.dataset.sizeBadgeFlashes))
}

function badge(page: Page, browserPageId: string) {
  return page.locator(`[data-browser-page-viewport-id="${browserPageId}"] [role="status"]`).first()
}

async function resizeAndReadBadge(
  page: Page,
  electronApp: ElectronApplication,
  browserPageId: string,
  guestUrl: string,
  width: number
): Promise<{ badge: string; guest: string | null }> {
  await setWindowWidth(electronApp, width)
  return expectBadgeMatchesGuest(page, electronApp, browserPageId, guestUrl)
}

async function expectBadgeMatchesGuest(
  page: Page,
  electronApp: ElectronApplication,
  browserPageId: string,
  guestUrl: string
): Promise<{ badge: string; guest: string | null }> {
  const indicator = badge(page, browserPageId)
  await expect(indicator).toHaveAttribute('aria-hidden', 'false', { timeout: 5_000 })
  await expect(indicator).toContainText('×')
  // Why poll: the guest learns its new size a frame after the host box resizes.
  let last: { badge: string; guest: string | null } = { badge: '', guest: null }
  await expect
    .poll(
      async () => {
        last = {
          guest: await guestViewportSize(electronApp, guestUrl),
          badge: (await indicator.textContent()) ?? ''
        }
        return last.guest === last.badge ? 'match' : `badge=${last.badge} guest=${last.guest}`
      },
      { timeout: 5_000 }
    )
    .toBe('match')
  return last
}

/** Waits until the guest stops resizing, e.g. after a UI zoom relayout. */
async function waitForStableGuestSize(
  electronApp: ElectronApplication,
  guestUrl: string
): Promise<void> {
  let previous: string | null = null
  await expect
    .poll(
      async () => {
        const current = await guestViewportSize(electronApp, guestUrl)
        const stable = current !== null && current === previous
        previous = current
        return stable
      },
      { timeout: 10_000, intervals: [300] }
    )
    .toBe(true)
}

test.describe('Browser viewport size badge', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('flashes the guest viewport size on resize under page and UI zoom', async ({
    orcaPage,
    electronApp
  }) => {
    const server = await startPageServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      await startCountingSizeFlashes(orcaPage)
      await orcaPage.evaluate(
        ({ targetWorktreeId, url }) => {
          window.__store?.getState().createBrowserTab(targetWorktreeId, url, {
            title: 'Viewport size',
            activate: true
          })
        },
        { targetWorktreeId: worktreeId, url: server.url }
      )
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 10_000 }).toBe('browser')
      const workspaceTabId = (await getBrowserTabs(orcaPage, worktreeId)).at(-1)!.id
      const browserPageId = await orcaPage.evaluate(
        (tabId) => window.__store?.getState().browserPagesByWorkspace[tabId]?.[0]?.id ?? '',
        workspaceTabId
      )
      await expect
        .poll(() => guestViewportSize(electronApp, server.url), { timeout: 15_000 })
        .not.toBeNull()

      // Opening the tab and switching away and back are not resizes.
      await orcaPage.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveTabType('terminal', id)
      }, worktreeId)
      await expect.poll(async () => getActiveTabType(orcaPage)).toBe('terminal')
      await orcaPage.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveTabType('browser', id)
      }, worktreeId)
      await expect.poll(async () => getActiveTabType(orcaPage)).toBe('browser')
      await orcaPage.waitForTimeout(1_000)
      expect(await sizeFlashCount(orcaPage)).toBe(0)
      await expect(badge(orcaPage, browserPageId)).toHaveAttribute('aria-hidden', 'true')

      // The first resize after opening the tab is announced too, even if the tab's opening
      // measurement arrived before the guest zoom was readable.
      await setWindowWidth(electronApp, 1400)
      await expect(badge(orcaPage, browserPageId)).toHaveAttribute('aria-hidden', 'false', {
        timeout: 5_000
      })
      await resizeAndReadBadge(orcaPage, electronApp, browserPageId, server.url, 1200)
      // The counter itself sees real flashes, so the zero above is meaningful.
      expect(await sizeFlashCount(orcaPage)).toBeGreaterThan(0)

      await orcaPage.evaluate((id) => {
        window.dispatchEvent(
          new CustomEvent('orca:browser-page-zoom', {
            detail: { browserPageId: id, direction: 'out' }
          })
        )
      }, browserPageId)
      await resizeAndReadBadge(orcaPage, electronApp, browserPageId, server.url, 1300)

      await setUiZoomLevel(orcaPage, 1)
      await waitForStableGuestSize(electronApp, server.url)
      await resizeAndReadBadge(orcaPage, electronApp, browserPageId, server.url, 1250)
      await orcaPage.screenshot({ path: test.info().outputPath('viewport-size-badge.png') })

      // Applying a preset resizes the page, so it flashes the emulated size once.
      await setUiZoomLevel(orcaPage, 0)
      await waitForStableGuestSize(electronApp, server.url)
      await expect(badge(orcaPage, browserPageId)).toHaveAttribute('aria-hidden', 'true', {
        timeout: 5_000
      })
      const freeSize = await guestViewportSize(electronApp, server.url)
      await orcaPage.evaluate((id) => {
        window.__store?.getState().setBrowserPageViewportPreset(id, 'mobile-m')
      }, browserPageId)
      const preset = await expectBadgeMatchesGuest(orcaPage, electronApp, browserPageId, server.url)
      expect(preset.guest).not.toBe(freeSize)

      // A preset pins the page size, so resizing the pane around it is not announced.
      await expect(badge(orcaPage, browserPageId)).toHaveAttribute('aria-hidden', 'true', {
        timeout: 5_000
      })
      await setWindowWidth(electronApp, 1350)
      await orcaPage.waitForTimeout(500)
      await expect(badge(orcaPage, browserPageId)).toHaveAttribute('aria-hidden', 'true')
    } finally {
      await setUiZoomLevel(orcaPage, 0)
      await server.close()
    }
  })
})
