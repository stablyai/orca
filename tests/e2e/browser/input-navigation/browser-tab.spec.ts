// Cover browser-tab creation and state retention across tab switches.

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getBrowserTabs,
  ensureTerminalVisible
} from '../../desktop/renderer-probes/store'
import { startBrowserLinkServer } from './browser-link-server'

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

async function startBrowserWindowCloseServer(): Promise<{
  url: string
  sourceUrl: string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const pathname = new URL(request.url ?? '/', origin).pathname
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (pathname === '/source') {
      response.end(`
        <!doctype html>
        <html>
          <head><title>Close link source</title></head>
          <body><input id="q" /><a id="window-close-link" href="${origin}/window-close" target="_blank">Open close page</a></body>
        </html>
      `)
      return
    }
    response.end(`
      <!doctype html>
      <html>
        <head><title>Window close repro</title></head>
        <body>
          <button id="window-close">Close this tab</button>
          <script>
            document.getElementById('window-close').onclick = () => {
              window.close = () => { document.title = 'Close override ran' }
              window.close()
            }
          </script>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/window-close`,
    sourceUrl: `http://127.0.0.1:${port}/source`,
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

async function clickBrowserLink(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string,
  selector: string,
  options: {
    modifiers?: ('meta' | 'control' | 'shift')[]
    button?: 'left' | 'middle' | 'right'
    frameSelector?: string
  } = {}
): Promise<void> {
  await expect(async () => {
    const ready = await page.evaluate(
      async ({ targetBrowserTabId, targetSelector, frameSelector }) => {
        const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
          (candidate) =>
            candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
        )
        const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
        if (!webview) {
          return false
        }
        return webview.executeJavaScript(`(() => {
          const frame = ${JSON.stringify(frameSelector)} ? document.querySelector(${JSON.stringify(frameSelector)}) : null
          const root = ${JSON.stringify(frameSelector)} ? frame?.contentDocument : document
          return Boolean(root?.querySelector(${JSON.stringify(targetSelector)}))
        })()`)
      },
      {
        targetBrowserTabId: browserTabId,
        targetSelector: selector,
        frameSelector: options.frameSelector ?? null
      }
    )
    expect(ready).toBe(true)
  }).toPass({ timeout: 5_000 })

  await page.evaluate(
    async ({ targetBrowserTabId, targetSelector, inputModifiers, button, frameSelector }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
      }
      const point: { x: number; y: number } | null = await webview.executeJavaScript(`(() => {
        const frame = ${JSON.stringify(frameSelector)}
          ? document.querySelector(${JSON.stringify(frameSelector)})
          : null
        const root = ${JSON.stringify(frameSelector)} ? frame?.contentDocument : document
        const linkRect = root?.querySelector(${JSON.stringify(targetSelector)})?.getBoundingClientRect()
        if (!linkRect) return null
        const frameRect = frame?.getBoundingClientRect()
        return {
          x: (frameRect?.left ?? 0) + linkRect.left + linkRect.width / 2,
          y: (frameRect?.top ?? 0) + linkRect.top + linkRect.height / 2
        }
      })()`)
      if (!point) {
        throw new Error(`Missing browser link ${targetSelector}`)
      }
      const holdShift = inputModifiers.includes('shift')
      if (holdShift) {
        await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] })
      }
      try {
        await webview.sendInputEvent({ type: 'mouseMove', modifiers: inputModifiers, ...point })
        await webview.sendInputEvent({
          type: 'mouseDown',
          button,
          clickCount: 1,
          modifiers: inputModifiers,
          ...point
        })
        await webview.sendInputEvent({
          type: 'mouseUp',
          button,
          clickCount: 1,
          modifiers: inputModifiers,
          ...point
        })
      } finally {
        if (holdShift) {
          await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' })
        }
      }
    },
    {
      targetBrowserTabId: browserTabId,
      targetSelector: selector,
      inputModifiers: options.modifiers ?? [],
      button: options.button ?? 'left',
      frameSelector: options.frameSelector ?? null
    }
  )
}

async function waitForTabIdByExactTitle(
  page: Parameters<typeof getActiveWorktreeId>[0],
  title: string
): Promise<string> {
  const resolveTabId = (): Promise<string | null> =>
    page.locator('[data-tab-id]').evaluateAll((tabs, exactTitle) => {
      const tab = tabs.find((candidate) => candidate.textContent?.trim() === exactTitle)
      return tab?.getAttribute('data-tab-id') ?? null
    }, title)
  await expect.poll(resolveTabId, { timeout: 10_000 }).not.toBeNull()
  const tabId = await resolveTabId()
  if (!tabId) {
    throw new Error(`Browser tab disappeared: ${title}`)
  }
  return tabId
}

async function expectBrowserTabActive(
  page: Parameters<typeof getActiveWorktreeId>[0],
  title: string
): Promise<void> {
  const tabId = await waitForTabIdByExactTitle(page, title)
  await expect(page.locator(`[data-browser-overlay-tab-id="${tabId}"]`)).toHaveCSS('opacity', '1')
}

async function expectBrowserTabOpenedInBackground(
  page: Parameters<typeof getActiveWorktreeId>[0],
  sourceTabId: string,
  title: string
): Promise<void> {
  const openedTabId = await waitForTabIdByExactTitle(page, title)
  await expect(page.locator(`[data-browser-overlay-tab-id="${sourceTabId}"]`)).toHaveCSS(
    'opacity',
    '1'
  )
  await expect(page.locator(`[data-browser-overlay-tab-id="${openedTabId}"]`)).toHaveCSS(
    'opacity',
    '0'
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

  test('new-tab link gestures follow Chrome foreground and background behavior', async ({
    electronApp,
    orcaPage
  }) => {
    const linkServer = await startBrowserLinkServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const sourceTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        linkServer.sourceUrl,
        'Source page'
      )
      expect(sourceTab?.id).toBeTruthy()

      const baseWindowCount = await electronApp.evaluate(
        ({ BaseWindow }) => BaseWindow.getAllWindows().length
      )
      // A plain main-frame target=_blank click must not navigate the source tab away.
      const sourceTabLocator = orcaPage.locator(`[data-tab-id="${sourceTab!.id}"]`)
      await clickBrowserLink(orcaPage, sourceTab!.id, '#blank-link')
      await expectBrowserTabActive(orcaPage, 'Blank target destination')
      await expect(sourceTabLocator).toContainText('Source page')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)

      // Context-menu links keep the source visible until the new tab is selected.
      await clickBrowserLink(orcaPage, sourceTab!.id, '#external-link', { button: 'right' })
      await orcaPage
        .getByRole('menuitem', { name: 'Open Link In Orca Browser', exact: true })
        .click()
      await expectBrowserTabOpenedInBackground(orcaPage, sourceTab!.id, 'Linked destination')
      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-link', {
        frameSelector: '#link-frame'
      })
      await expectBrowserTabActive(orcaPage, 'Frame destination')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-modifier-link', {
        frameSelector: '#link-frame',
        modifiers: process.platform === 'darwin' ? ['meta'] : ['control']
      })
      await expectBrowserTabOpenedInBackground(
        orcaPage,
        sourceTab!.id,
        'Frame modifier destination'
      )
      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-middle-link', {
        button: 'middle',
        frameSelector: '#link-frame'
      })
      await expectBrowserTabOpenedInBackground(orcaPage, sourceTab!.id, 'Frame middle destination')

      await clickBrowserLink(orcaPage, sourceTab!.id, '#modifier-link', {
        modifiers: process.platform === 'darwin' ? ['meta'] : ['control']
      })
      await expectBrowserTabOpenedInBackground(orcaPage, sourceTab!.id, 'Modifier destination')

      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-shift-middle-link', {
        button: 'middle',
        modifiers: ['shift'],
        frameSelector: '#link-frame'
      })
      await expectBrowserTabActive(orcaPage, 'Frame shift middle destination')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)

      const tabCountBeforeCancelledClick = await orcaPage.locator('[data-tab-id]').count()
      await clickBrowserLink(orcaPage, sourceTab!.id, '#cancelled-link')
      await expect(
        orcaPage.locator('[data-tab-id]').filter({ hasText: 'Click handled in page' })
      ).toBeVisible({ timeout: 10_000 })
      await expect(orcaPage.locator('[data-tab-id]')).toHaveCount(tabCountBeforeCancelledClick)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#middle-link', { button: 'middle' })
      await expectBrowserTabOpenedInBackground(orcaPage, sourceTab!.id, 'Middle-click destination')
      await expect
        .poll(() => electronApp.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), {
          timeout: 5_000
        })
        .toBe(baseWindowCount)
    } finally {
      await linkServer.close()
    }
  })

  test('window.close removes a link-created tab and keeps neighboring tabs usable', async ({
    orcaPage
  }) => {
    const closeServer = await startBrowserWindowCloseServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const neighboringTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        closeServer.sourceUrl,
        'Neighboring tab'
      )
      const sourceTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        closeServer.sourceUrl,
        'Close link source'
      )
      expect(neighboringTab?.id).toBeTruthy()
      expect(sourceTab?.id).toBeTruthy()

      await clickBrowserLink(orcaPage, sourceTab!.id, '#window-close-link')
      let closeTabId: string | null = null
      await expect
        .poll(async () => {
          const tabs = await getBrowserTabs(orcaPage, worktreeId)
          closeTabId = tabs.find((tab) => tab.url === closeServer.url)?.id ?? null
          return closeTabId
        })
        .not.toBeNull()

      await clickBrowserLink(orcaPage, closeTabId!, '#window-close')
      await expect
        .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).map((tab) => tab.id))
        .not.toContain(closeTabId)
      expect((await getBrowserTabs(orcaPage, worktreeId)).map((tab) => tab.id)).toContain(
        sourceTab!.id
      )
      await orcaPage.locator(`[data-tab-id="${neighboringTab!.id}"]`).click()
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')
      await expect(
        orcaPage.locator(`[data-browser-overlay-tab-id="${neighboringTab!.id}"]`)
      ).toHaveCSS('opacity', '1')
      await writeBrowserInputValue(orcaPage, neighboringTab!.id, 'still usable after close')
    } finally {
      await closeServer.close()
    }
  })

  test('a single-entry browser tab honors protected window.close and preserves its neighbor', async ({
    orcaPage
  }) => {
    const closeServer = await startBrowserWindowCloseServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const neighboringTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        closeServer.sourceUrl,
        'Neighbor'
      )
      expect(neighboringTab?.id).toBeTruthy()
      const directTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        closeServer.url,
        'Direct close tab'
      )
      expect(directTab?.id).toBeTruthy()

      await clickBrowserLink(orcaPage, directTab!.id, '#window-close')
      await expect
        .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).map((tab) => tab.id))
        .not.toContain(directTab!.id)
      await orcaPage.locator(`[data-tab-id="${neighboringTab!.id}"]`).click()
      await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')
      await expect(
        orcaPage.locator(`[data-browser-overlay-tab-id="${neighboringTab!.id}"]`)
      ).toHaveCSS('opacity', '1')
      await writeBrowserInputValue(orcaPage, neighboringTab!.id, 'still usable after close')
    } finally {
      await closeServer.close()
    }
  })
})
