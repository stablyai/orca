/**
 * E2E regression for issue #9937: Ctrl+Tab MRU switcher got stuck open when the
 * gesture started inside a focused in-app browser (webview guest).
 *
 * Root cause: the guest's before-input-event handler preventDefault-s the
 * Ctrl+Tab keydown, and Chromium then suppresses every guest keyup until the
 * next keydown — so the modifier-release commit could never arrive over IPC.
 * The fix hands the rest of the held gesture to the renderer window: opening
 * the switcher from a guest pulls DOM focus out of the webview, so release/
 * advance/Escape flow through the renderer's key handlers.
 */

import { test, expect } from './helpers/orca-app'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  ensureTerminalVisible
} from './helpers/store'

type OrcaPage = Parameters<typeof getActiveWorktreeId>[0]

async function startFocusablePageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>Guest page</title></head><body><input id="q" autofocus /></body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error: Error | undefined) => (error ? reject(error) : resolve()))
      )
  }
}

async function createBrowserTab(
  page: OrcaPage,
  worktreeId: string,
  url: string
): Promise<string | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetUrl }) => {
      const store = window.__store
      if (!store) {
        return null
      }
      const tab = store
        .getState()
        .createBrowserTab(targetWorktreeId, targetUrl, { title: 'Guest page', activate: true })
      return tab.id
    },
    { targetWorktreeId: worktreeId, targetUrl: url }
  )
}

async function focusGuestPage(page: OrcaPage, browserTabId: string): Promise<void> {
  await page.evaluate(async (targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
    }
    webview.focus()
    await webview.executeJavaScript('document.querySelector("#q")?.focus()')
  }, browserTabId)
}

async function sendGuestCtrlTabKeyDown(page: OrcaPage, browserTabId: string): Promise<void> {
  await page.evaluate(
    async ({ targetBrowserTabId }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
      }
      await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
    },
    { targetBrowserTabId: browserTabId }
  )
}

async function getRendererActiveElementTag(page: OrcaPage): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.tagName ?? null)
}

async function getSelectedSwitcherLabel(page: OrcaPage): Promise<string | null> {
  const selected = page.locator('[role="listbox"] [role="option"][aria-selected="true"]')
  return (await selected.count()) === 1 ? selected.textContent() : null
}

test.describe('Ctrl+Tab switcher from focused browser guest', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('opens from the guest and commits on modifier release', async ({ orcaPage }) => {
    const pageServer = await startFocusablePageServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const browserTabId = await createBrowserTab(orcaPage, worktreeId, pageServer.url)
      expect(browserTabId).toBeTruthy()
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')
      await focusGuestPage(orcaPage, browserTabId!)

      const overlay = orcaPage.locator('[role="listbox"][aria-label="Switch tabs"]')
      await sendGuestCtrlTabKeyDown(orcaPage, browserTabId!)
      await expect(overlay).toBeVisible({ timeout: 5_000 })

      // The renderer must own the rest of the held gesture: a prevented guest
      // keydown suppresses guest keyups, so focus has to leave the webview.
      await expect
        .poll(async () => getRendererActiveElementTag(orcaPage), { timeout: 5_000 })
        .not.toBe('WEBVIEW')

      // Modifier release now reaches the renderer window and commits.
      await orcaPage.keyboard.down('Control')
      await orcaPage.keyboard.up('Control')
      await expect(overlay).toBeHidden({ timeout: 5_000 })
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('terminal')
    } finally {
      await pageServer.close()
    }
  })

  test('advances while held and returns focus to the committed browser page', async ({
    orcaPage
  }) => {
    const pageServer = await startFocusablePageServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const browserTabId = await createBrowserTab(orcaPage, worktreeId, pageServer.url)
      expect(browserTabId).toBeTruthy()
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')
      await focusGuestPage(orcaPage, browserTabId!)

      const overlay = orcaPage.locator('[role="listbox"][aria-label="Switch tabs"]')
      await sendGuestCtrlTabKeyDown(orcaPage, browserTabId!)
      await expect(overlay).toBeVisible({ timeout: 5_000 })

      // Keep tapping Tab (Ctrl held) until the browser tab is selected again,
      // then release: the switcher must commit back to it and hand focus to
      // the guest page rather than leaving it stranded on the renderer body.
      await orcaPage.keyboard.down('Control')
      const itemCount = await overlay.locator('[role="option"]').count()
      for (let step = 0; step < itemCount; step += 1) {
        if ((await getSelectedSwitcherLabel(orcaPage))?.includes('Guest page')) {
          break
        }
        await orcaPage.keyboard.press('Tab')
      }
      expect(await getSelectedSwitcherLabel(orcaPage)).toContain('Guest page')
      await orcaPage.keyboard.up('Control')

      await expect(overlay).toBeHidden({ timeout: 5_000 })
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')
      await expect
        .poll(async () => getRendererActiveElementTag(orcaPage), { timeout: 5_000 })
        .toBe('WEBVIEW')
    } finally {
      await pageServer.close()
    }
  })
})
