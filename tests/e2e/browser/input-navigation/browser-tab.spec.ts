// Cover browser-tab creation and state retention across tab switches.

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  ensureTerminalVisible
} from '../../desktop/renderer-probes/store'
import './browser-link-server'

type CreatedBrowserTab = {
  id: string
  pageId: string | null
}

async function createBrowserTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string,
  url?: string,
  title = 'New Browser Tab'
): Promise<CreatedBrowserTab | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetUrl, targetTitle }) => {
      const store = window.__store
      if (!store) {
        return null
      }

      const state = store.getState()
      const tab = state.createBrowserTab(
        targetWorktreeId,
        targetUrl ?? state.browserDefaultUrl ?? 'about:blank',
        {
          title: targetTitle,
          activate: true
        }
      )
      return { id: tab.id, pageId: tab.activePageId ?? null }
    },
    { targetWorktreeId: worktreeId, targetUrl: url, targetTitle: title }
  )
}

async function switchToBrowserTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string,
  browserTabId: string
): Promise<void> {
  await page.evaluate(
    ({ targetWorktreeId, targetBrowserTabId }) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      if (
        (state.browserTabsByWorktree[targetWorktreeId] ?? []).some(
          (tab) => tab.id === targetBrowserTabId
        )
      ) {
        state.setActiveBrowserTab(targetBrowserTabId)
      }
    },
    { targetWorktreeId: worktreeId, targetBrowserTabId: browserTabId }
  )
}

async function startBrowserFormServer(host = '127.0.0.1'): Promise<{
  url: (label: string) => string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const label = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`
      <!doctype html>
      <html>
        <body>
          <label>${label}<input id="q" /></label>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (label: string) => `http://${host}:${port}/${encodeURIComponent(label)}`,
    close: () => closeServer(server)
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  )
}

async function readBrowserInputValue(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string
): Promise<string | null> {
  return page.evaluate(async (targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return null
    }
    try {
      return await webview.executeJavaScript('document.querySelector("#q")?.value ?? null')
    } catch {
      return null
    }
  }, browserTabId)
}

async function writeBrowserInputValue(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string,
  value: string
): Promise<void> {
  await expect
    .poll(async () => readBrowserInputValue(page, browserTabId), { timeout: 5_000 })
    .not.toBeNull()

  await page.evaluate(
    async ({ targetBrowserTabId, nextValue }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
      }
      await webview.executeJavaScript(
        `document.querySelector("#q").value = ${JSON.stringify(nextValue)}`
      )
    },
    { targetBrowserTabId: browserTabId, nextValue: value }
  )

  await expect
    .poll(async () => readBrowserInputValue(page, browserTabId), { timeout: 5_000 })
    .toBe(value)
}

test.describe('Browser Tab', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('browser webview form state survives switching between browser tabs', async ({
    orcaPage
  }) => {
    const formServer = await startBrowserFormServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const firstTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        formServer.url('First search'),
        'First Form'
      )
      expect(firstTab?.id).toBeTruthy()
      await writeBrowserInputValue(orcaPage, firstTab!.id, 'first typed value')

      const secondTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        formServer.url('Second search'),
        'Second Form'
      )
      expect(secondTab?.id).toBeTruthy()
      await writeBrowserInputValue(orcaPage, secondTab!.id, 'second typed value')

      // Why: switching browser tabs used to unmount and reparent the inactive
      // Electron webview, which recreated the guest document and erased form DOM.
      await switchToBrowserTab(orcaPage, worktreeId, firstTab!.id)
      await expect
        .poll(async () => readBrowserInputValue(orcaPage, firstTab!.id), { timeout: 5_000 })
        .toBe('first typed value')

      await switchToBrowserTab(orcaPage, worktreeId, secondTab!.id)
      await expect
        .poll(async () => readBrowserInputValue(orcaPage, secondTab!.id), { timeout: 5_000 })
        .toBe('second typed value')
    } finally {
      await formServer.close()
    }
  })
})
