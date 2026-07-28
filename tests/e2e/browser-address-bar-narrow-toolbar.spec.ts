/**
 * E2E regression for issue #11090: in a narrow browser pane every toolbar
 * button stays shrink-0, so the address bar absorbed the whole squeeze and
 * became an unusable globe icon with a zero-width input. Focusing it must now
 * overlay the toolbar with a typable field that navigates on Enter.
 */

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
import { BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH } from '../../src/renderer/src/components/browser-pane/browser-address-bar-expansion'

// Why: the left sidebar keeps its default 280px, so this leaves the browser
// pane around 420px — narrow enough to squeeze the address bar away, wide
// enough that the toolbar itself still renders its buttons.
const NARROW_WINDOW_WIDTH = 700
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

async function closeRightSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().setRightSidebarOpen(false)
  })
}

async function resizeWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('No Electron window')
      }
      window.setSize(width, height)
    },
    { width: NARROW_WINDOW_WIDTH, height: NARROW_WINDOW_HEIGHT }
  )
}

function addressBarInput(page: Page): Locator {
  return page.locator('[data-orca-browser-address-bar="true"]')
}

async function blurAddressBar(page: Page): Promise<void> {
  await addressBarInput(page).evaluate((node) => node.blur())
}

async function addressBarInputWidth(page: Page): Promise<number> {
  return addressBarInput(page).evaluate((node) => node.getBoundingClientRect().width)
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
      await closeRightSidebar(orcaPage)
      await resizeWindow(electronApp)

      // Why: a fresh blank tab auto-focuses the address bar, which already
      // expands it. Blur first to observe the squeezed resting state.
      await blurAddressBar(orcaPage)

      const overlay = orcaPage.locator('[data-orca-browser-address-bar-overlay="true"]')
      await expect(overlay).toHaveCount(0)
      // The bug: the inline field is squeezed away entirely.
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
