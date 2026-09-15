import { test, expect } from './helpers/orca-app'
import { worktreeRowSurface } from './worktree-row-locators'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { startPlacementFixtureServer } from './helpers/paired-browser-placement-fixture'
import {
  browserViewIdForPage,
  openWorkspaceWindow,
  expectHiddenWorkspaceWindows
} from './helpers/workspace-window'
import { multiwindowSearchJourney } from './helpers/multiwindow-search-journey'
import { multiwindowRestartJourney } from './helpers/multiwindow-restart-journey'
import { registerMultiwindowTransferJourneys } from './helpers/multiwindow-transfer-journeys'
import type { Page } from '@stablyai/playwright-test'

let rendererErrors: string[]
test.beforeEach(({ electronApp }) => {
  rendererErrors = []
  const observe = (page: Page) => {
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text())
      }
    })
  }
  electronApp.windows().forEach(observe)
  electronApp.on('window', observe)
})
test.afterEach(() => expect(rendererErrors).toEqual([]))

registerMultiwindowTransferJourneys()

test(
  'two projects retain repeated views through Jump, layout recovery and live sessions',
  multiwindowSearchJourney
)
test(
  'independent windows restore selected mixed panes and dirty editors after restart',
  multiwindowRestartJourney
)

test('rendered windows select separate sessions and remain usable after primary close', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const server = await startPlacementFixtureServer()
  try {
    const selection = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      const first = state.tabsByWorktree[worktreeId]?.[0] ?? state.createTab(worktreeId)
      const second = state.createTab(worktreeId)
      return { first: first.id, second: second.id, worktreeId }
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ worktreeId, second }) =>
            window.__store!.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === second)
              ?.ptyId,
          selection
        )
      )
      .toBeTruthy()
    const browser = await orcaPage.evaluate(
      ({ worktreeId, url }) => {
        const tab = window.__store!.getState().createBrowserTab(worktreeId, url, { activate: true })
        return { tabId: tab.id, pageId: tab.activePageId! }
      },
      { worktreeId: selection.worktreeId, url: server.url }
    )
    await expect
      .poll(() =>
        orcaPage.evaluate((url) => {
          const view = Array.from(document.querySelectorAll('webview')).find((item) => {
            try {
              return (item as Electron.WebviewTag).getURL() === url
            } catch {
              return false
            }
          }) as Electron.WebviewTag | undefined
          return view?.getWebContentsId() ?? null
        }, server.url)
      )
      .toBeTruthy()
    const guestId = await orcaPage.evaluate(async (url) => {
      const view = Array.from(document.querySelectorAll('webview')).find(
        (item) => (item as Electron.WebviewTag).getURL() === url
      ) as Electron.WebviewTag
      await view.executeJavaScript(
        `document.body.innerHTML = '<input id="continuity" value="retained" style="position:fixed;left:0;top:0;width:400px;height:80px">'`
      )
      return view.getWebContentsId()
    }, server.url)
    const primaryId = await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id
    )
    const primaryErrors: string[] = []
    orcaPage.on('pageerror', (error) => primaryErrors.push(error.message))
    const secondary = await openWorkspaceWindow(electronApp)
    const errors: string[] = []
    secondary.on('pageerror', (error) => errors.push(error.message))
    expect(await secondary.evaluate(() => document.visibilityState)).toBe('visible')
    await worktreeRowSurface(secondary, selection.worktreeId).click()
    const primaryFirst = orcaPage.locator(`[data-tab-id="${selection.first}"]`)
    const secondarySecond = secondary.locator(
      `[data-tab-id^="${toWebTerminalSurfaceTabId(selection.second)}"]`
    )
    await primaryFirst.click()
    await secondarySecond.click()
    await expect(primaryFirst).toHaveAttribute('data-active', 'true')
    await expect(secondarySecond).toHaveAttribute('data-active', 'true')

    const secondaryId = await electronApp.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows().find((window) => window.id !== id)!.id,
      primaryId
    )
    const primarySidebar = await orcaPage.evaluate(() => window.__store!.getState().sidebarOpen)
    const secondarySidebar = await secondary.evaluate(() => window.__store!.getState().sidebarOpen)
    await electronApp.evaluate(({ BrowserWindow, Menu }, id) => {
      const appearance = Menu.getApplicationMenu()!
        .items.find((item) => item.label === 'View')!
        .submenu!.items.find((item) => item.label === 'Appearance')!
      const item = appearance.submenu!.items.find((item) =>
        item.label.startsWith('Toggle Left Sidebar')
      )!
      item.click(item, BrowserWindow.fromId(id)!, {} as never)
    }, secondaryId)
    await expect
      .poll(() => secondary.evaluate(() => window.__store!.getState().sidebarOpen))
      .toBe(!secondarySidebar)
    expect(await orcaPage.evaluate(() => window.__store!.getState().sidebarOpen)).toBe(
      primarySidebar
    )

    // Closing presentation keeps the authoritative renderer available for runtime requests.
    await orcaPage.evaluate(() => {
      window.api.ui.requestClose()
    })
    expect(
      await electronApp.evaluate(({ BrowserWindow }, id) => {
        const primary = BrowserWindow.fromId(id)
        return !!primary && !primary.isDestroyed() && !primary.isVisible()
      }, primaryId)
    ).toBe(true)
    const secondaryFirst = secondary.locator(
      `[data-tab-id^="${toWebTerminalSurfaceTabId(selection.first)}"]`
    )
    await secondaryFirst.click()
    await expect(secondaryFirst).toHaveAttribute('data-active', 'true')
    const created = await secondary.evaluate(async ({ worktreeId }) => {
      const response = await window.api.runtime.call({
        method: 'session.tabs.createTerminal',
        params: { worktree: `id:${worktreeId}`, navigation: 'caller' }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    }, selection)
    expect(created).toBeTruthy()
    expect(primaryErrors).toEqual([])
    const browserViewId = await browserViewIdForPage(secondary, browser.pageId)
    await secondary.locator(`[data-tab-id="${browserViewId}"]`).click()
    const frame = secondary.getByTestId('remote-browser-frame')
    await expect(frame).toBeVisible({ timeout: 30_000 })
    await frame.click({ position: { x: 50, y: 30 } })
    await expect
      .poll(
        () =>
          electronApp.evaluate(
            async ({ webContents }, id) =>
              webContents.fromId(id)!.executeJavaScript('document.activeElement.id'),
            guestId
          ),
        { timeout: 30_000 }
      )
      .toBe('continuity')
    await frame.press('End')
    await frame.pressSequentially('-second')
    await expect
      .poll(() =>
        electronApp.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript('document.querySelector("#continuity").value'),
          guestId
        )
      )
      .toBe('retained-second')
    await secondary.reload()
    await secondary.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await worktreeRowSurface(secondary, selection.worktreeId).click()
    const restoredViewId = await browserViewIdForPage(secondary, browser.pageId)
    await secondary.locator(`[data-tab-id="${restoredViewId}"]`).click()
    await expect(secondary.getByTestId('remote-browser-frame')).toBeVisible({ timeout: 30_000 })
    expect(
      await electronApp.evaluate(
        async ({ webContents }, id) =>
          webContents.fromId(id)!.executeJavaScript('document.querySelector("#continuity").value'),
        guestId
      )
    ).toBe('retained-second')
    await secondary.screenshot({ path: testInfo.outputPath('secondary-after-primary-close.png') })
    expect(errors).toEqual([])
    await expectHiddenWorkspaceWindows(electronApp)
    await secondary.evaluate(() => window.api.ui.requestClose())
    await expect.poll(() => secondary.isClosed()).toBe(true)
  } finally {
    await server.close()
  }
})
