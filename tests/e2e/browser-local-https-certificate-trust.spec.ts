import type { Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { startLocalHttpProbeServer, startLocalHttpsServer } from './helpers/local-https-test-server'

type CreatedBrowserTab = {
  id: string
  pageId: string
}

async function createBrowserTab(
  page: Page,
  worktreeId: string,
  url: string
): Promise<CreatedBrowserTab> {
  const tab = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) => {
      const state = window.__store?.getState()
      if (!state) {
        return null
      }
      const browserTab = state.createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Local TLS',
        activate: true
      })
      return { id: browserTab.id, pageId: browserTab.activePageId ?? null }
    },
    { targetWorktreeId: worktreeId, targetUrl: url }
  )
  if (!tab?.pageId) {
    throw new Error('Failed to create local TLS browser page')
  }
  return { id: tab.id, pageId: tab.pageId }
}

async function switchToBrowserTab(page: Page, worktreeId: string, browserTabId: string) {
  await page.evaluate(
    ({ targetWorktreeId, targetBrowserTabId }) => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      if (
        !(state.browserTabsByWorktree[targetWorktreeId] ?? []).some(
          (tab) => tab.id === targetBrowserTabId
        )
      ) {
        return
      }
      state.setActiveBrowserTab(targetBrowserTabId)
      state.setActiveTabType('browser')
    },
    { targetWorktreeId: worktreeId, targetBrowserTabId: browserTabId }
  )
}

function browserSlot(page: Page, pageId: string) {
  return page.locator(`[data-browser-overlay-tab-id="${pageId}"]`)
}

async function readBrowserHeading(page: Page, browserTabId: string): Promise<string | null> {
  return page.evaluate(async (targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return null
    }
    try {
      return await webview.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
    } catch {
      return null
    }
  }, browserTabId)
}

async function readBrowserState(
  page: Page,
  browserTabId: string,
  stateName: '__localTlsState' | '__siblingTlsProbe'
): Promise<Record<string, boolean | string> | null> {
  return page.evaluate(
    async ({ targetBrowserTabId, targetStateName }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        return null
      }
      try {
        return await webview.executeJavaScript(`window.${targetStateName} ?? null`)
      } catch {
        return null
      }
    },
    { targetBrowserTabId: browserTabId, targetStateName: stateName }
  )
}

async function reloadBrowserGuest(page: Page, browserTabId: string): Promise<void> {
  await page.evaluate((targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
    }
    webview.reload()
  }, browserTabId)
}

test.describe('local HTTPS certificate trust', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('approves one exact local certificate endpoint without trusting sibling tabs or ports', async ({
    orcaPage
  }) => {
    const firstServer = await startLocalHttpsServer()
    const secondPortServer = await startLocalHttpsServer()
    const siblingProbeServer = await startLocalHttpProbeServer(firstServer)
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const firstTab = await createBrowserTab(orcaPage, worktreeId, firstServer.schemeLessUrl)
      const firstSlot = browserSlot(orcaPage, firstTab.id)

      await expect(firstSlot.getByRole('button', { name: 'Try HTTPS' })).toBeVisible()
      await firstSlot.getByRole('button', { name: 'Try HTTPS' }).click()
      await expect(
        firstSlot.getByRole('heading', { name: "Connection isn't secure" })
      ).toBeVisible()
      // The certificate-failure branch keeps its safe recovery actions and the
      // certificate-specific hint, but never the local-server connectivity hint.
      await expect(firstSlot.getByRole('button', { name: 'Copy Address' })).toBeVisible()
      await expect(firstSlot.getByRole('button', { name: 'Retry' })).toBeVisible()
      await expect(firstSlot.getByText(/use a trusted local certificate/i)).toBeVisible()
      await expect(firstSlot.getByText(/make sure the server is running/i)).toHaveCount(0)
      await firstSlot.getByRole('button', { name: 'Proceed Anyway (Unsafe)' }).click()
      await expect
        .poll(() => readBrowserHeading(orcaPage, firstTab.id), { timeout: 10_000 })
        .toBe('Local HTTPS request 1')
      await expect
        .poll(() => readBrowserState(orcaPage, firstTab.id, '__localTlsState'))
        .toEqual({ asset: true, webSocket: true })
      expect(firstServer.assetRequestCount()).toBe(1)
      expect(firstServer.webSocketConnectionCount()).toBe(1)

      const secondTab = await createBrowserTab(orcaPage, worktreeId, firstServer.secureUrl)
      const secondSlot = browserSlot(orcaPage, secondTab.id)
      await expect(
        secondSlot.getByRole('heading', { name: "Connection isn't secure" })
      ).toBeVisible()
      // Why: approval is scoped to the first guest WebContents, not its shared
      // profile partition, so this sibling still requires an explicit decision.
      await expect(
        secondSlot.getByRole('button', { name: 'Proceed Anyway (Unsafe)' })
      ).toBeVisible()

      const probeTab = await createBrowserTab(orcaPage, worktreeId, siblingProbeServer.url)
      await expect
        .poll(() => readBrowserState(orcaPage, probeTab.id, '__siblingTlsProbe'))
        .toEqual({ asset: 'blocked', webSocket: 'blocked' })
      expect(firstServer.assetRequestCount()).toBe(1)
      expect(firstServer.webSocketConnectionCount()).toBe(1)

      await switchToBrowserTab(orcaPage, worktreeId, firstTab.id)
      await reloadBrowserGuest(orcaPage, firstTab.id)
      await expect.poll(firstServer.documentRequestCount, { timeout: 10_000 }).toBe(2)
      await expect
        .poll(() => readBrowserHeading(orcaPage, firstTab.id), { timeout: 10_000 })
        .toBe('Local HTTPS request 2')
      await expect.poll(firstServer.assetRequestCount).toBe(2)
      await expect.poll(firstServer.webSocketConnectionCount).toBe(2)

      const firstAddressBar = firstSlot.locator('[data-orca-browser-address-bar="true"]')
      await firstAddressBar.fill(secondPortServer.secureUrl)
      await firstAddressBar.press('Enter')
      await expect(
        firstSlot.getByRole('heading', { name: "Connection isn't secure" })
      ).toBeVisible()
      await expect(firstSlot.getByRole('button', { name: 'Proceed Anyway (Unsafe)' })).toBeVisible()
      await expect.poll(secondPortServer.documentRequestCount).toBe(0)
    } finally {
      await Promise.all([firstServer.close(), secondPortServer.close(), siblingProbeServer.close()])
    }
  })
})
