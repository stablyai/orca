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

// Why: the toolbar must land in a band — squeezed enough that the inline field
// collapses, roomy enough that the overlay itself has somewhere to go. Target
// the middle of that band rather than a fixed window width, because how much
// chrome flanks the pane (left sidebar, and a right sidebar that other startup
// paths may re-open) varies between runs.
const TARGET_TOOLBAR_WIDTH = 420
const MIN_USABLE_TOOLBAR_WIDTH = BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH + 100
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

/**
 * Drive the app to the resting state this spec is about: a squeezed-but-usable
 * toolbar whose address bar is collapsed and unfocused.
 *
 * Why one loop rather than three: both preconditions are actively fought by the
 * app. Startup paths re-open the right sidebar (which alone leaves the pane
 * ~70px, too narrow for the overlay to have anywhere to go), and BrowserPane
 * re-focuses a blank tab's address bar across several animation frames plus the
 * blank-url did-finish-load handler. Settling them separately just lets whichever
 * settled first drift back while the next one runs, so re-assert all of them
 * together until they hold at the same time. The interval must clear the 200ms
 * blur-close timer in BrowserAddressBar for the collapse to register.
 */
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
        // Chrome flanking the pane is everything the toolbar didn't get.
        await setWindowWidth(electronApp, innerWidth - toolbar + TARGET_TOOLBAR_WIDTH)
        await addressBarInput(page).evaluate((node) => node.blur())
        return {
          toolbar: (await toolbarWidth(page)) > MIN_USABLE_TOOLBAR_WIDTH,
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
