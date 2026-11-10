// Narrow-pane regression #11090: focus must expand a collapsed address field into a usable navigation overlay.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from './helpers/orca-app'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  getActiveTabType,
  getActiveWorktreeId,
  getBrowserTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH } from '../../src/renderer/src/components/browser-pane/assemble-chrome/browser-address-bar-expansion'

// Target the middle of the toolbar’s collapse band because sidebar chrome varies between runs.
const TARGET_TOOLBAR_WIDTH = 260
const MIN_USABLE_TOOLBAR_WIDTH = BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH + 20
const NARROW_WINDOW_HEIGHT = 800

async function startDestinationServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>Typed destination</title></head><body>ok</body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/typed`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function createBlankBrowserTab(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    window.__store?.getState().createBrowserTab(targetWorktreeId, 'about:blank', {
      title: 'Narrow toolbar tab',
      activate: true
    })
  }, worktreeId)
  await expect.poll(async () => getActiveTabType(page), { timeout: 10_000 }).toBe('browser')
}

async function setWindowWidth(electronApp: ElectronApplication, width: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('No Electron window')
      }
      // Window minimums otherwise mask the narrow-pane state on some runners.
      window.setMinimumSize(0, 0)
      window.setSize(size.width, size.height)
    },
    { width: Math.round(width), height: NARROW_WINDOW_HEIGHT }
  )
}

function browserToolbar(page: Page): Locator {
  return page.locator('[data-contextual-tour-target="browser-toolbar"]').first()
}

async function toolbarWidth(page: Page): Promise<number> {
  return browserToolbar(page).evaluate((node) => Math.round(node.getBoundingClientRect().width))
}

function addressBarInput(page: Page): Locator {
  return page.locator('[data-orca-browser-address-bar="true"]')
}

function addressBarOverlay(page: Page): Locator {
  return page.locator('[data-orca-browser-address-bar-overlay="true"]')
}

async function addressBarInputWidth(page: Page): Promise<number> {
  return addressBarInput(page).evaluate((node) => node.getBoundingClientRect().width)
}

// Settle width, sidebar and focus together because startup paths fight each precondition.
// Let the 200ms blur timer finish before accepting collapse.
async function settleToSqueezedRestingState(
  page: Page,
  electronApp: ElectronApplication
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          window.__store?.getState().setRightSidebarOpen(false)
        })
        const [innerWidth, toolbar] = await Promise.all([
          page.evaluate(() => window.innerWidth),
          toolbarWidth(page)
        ])
        await setWindowWidth(electronApp, innerWidth - toolbar + TARGET_TOOLBAR_WIDTH)
        await addressBarInput(page).evaluate((node) => node.blur())
        const measuredToolbar = await toolbarWidth(page)
        return {
          toolbar:
            measuredToolbar > MIN_USABLE_TOOLBAR_WIDTH &&
            measuredToolbar <= TARGET_TOOLBAR_WIDTH + 5,
          collapsed: (await addressBarOverlay(page).count()) === 0
        }
      },
      { timeout: 30_000, intervals: [300, 300, 300, 500, 500, 1000] }
    )
    .toEqual({ toolbar: true, collapsed: true })
}

test.describe('Browser address bar in a narrow toolbar', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('focusing the squeezed address bar expands a typable field that navigates', async ({
    orcaPage,
    electronApp
  }) => {
    const destination = await startDestinationServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      await createBlankBrowserTab(orcaPage, worktreeId)
      await settleToSqueezedRestingState(orcaPage, electronApp)

      const overlay = addressBarOverlay(orcaPage)
      await expect.poll(() => addressBarInputWidth(orcaPage), { timeout: 10_000 }).toBeLessThan(40)

      await orcaPage.locator('form:has(> [data-orca-browser-address-bar="true"])').click()

      await expect(overlay).toBeVisible()
      await expect
        .poll(() => addressBarInputWidth(orcaPage), { timeout: 5_000 })
        .toBeGreaterThan(BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH / 2)

      await addressBarInput(orcaPage).fill(destination.url)
      await addressBarInput(orcaPage).press('Enter')

      await expect
        .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).at(-1)?.url ?? null, {
          timeout: 15_000
        })
        .toContain('/typed')
    } finally {
      await destination.close()
    }
  })
})
