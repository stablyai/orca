// Cover browser-tab creation and state retention across tab switches.

import { test, expect } from './helpers/orca-app'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getBrowserTabs,
  ensureTerminalVisible
} from './helpers/store'
import { startBrowserLinkServer } from './helpers/browser-link-server'

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
  await page.evaluate(
    async ({ targetBrowserTabId, targetSelector, inputModifiers, button, frameSelector }) => {
      const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
        (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
      )
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
      }
      const point = (await webview.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const frame = ${JSON.stringify(frameSelector)}
            ? document.querySelector(${JSON.stringify(frameSelector)})
            : null
          const root = frame?.contentDocument ?? document
          const linkRect = root.querySelector(${JSON.stringify(targetSelector)})?.getBoundingClientRect()
          if (linkRect) {
            const frameRect = frame?.getBoundingClientRect()
            return {
              x: (frameRect?.left ?? 0) + linkRect.left + linkRect.width / 2,
              y: (frameRect?.top ?? 0) + linkRect.top + linkRect.height / 2
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        return null
      })()`)) as { x: number; y: number } | null
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
  return (await resolveTabId()) as string
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

  test('browser page reload restores the configured 100% zoom', async ({ orcaPage }) => {
    const formServer = await startBrowserFormServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const browserTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        formServer.url('Zoom reload'),
        'Zoom Reload'
      )
      expect(browserTab?.id).toBeTruthy()
      await expect
        .poll(async () => readBrowserInputValue(orcaPage, browserTab!.id), { timeout: 5_000 })
        .not.toBeNull()

      const zoomLevels = await orcaPage.evaluate(async (browserTabId) => {
        const slot = document.querySelector(`[data-browser-overlay-tab-id="${browserTabId}"]`)
        const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
        if (!webview) {
          throw new Error(`Missing webview for browser tab ${browserTabId}`)
        }

        const levels = [webview.getZoomLevel()]
        webview.setZoomLevel(0.5)
        for (let reload = 0; reload < 3; reload += 1) {
          await new Promise<void>((resolve) => {
            const onReady = (): void => {
              webview.removeEventListener('dom-ready', onReady)
              resolve()
            }
            webview.addEventListener('dom-ready', onReady)
            if (reload === 1) {
              webview.reloadIgnoringCache()
            } else {
              webview.reload()
            }
          })
          levels.push(webview.getZoomLevel())
        }
        return levels
      }, browserTab!.id)

      expect(zoomLevels).toEqual([0, 0, 0, 0])
    } finally {
      await formServer.close()
    }
  })

  test('Cmd/Ctrl+0 resets a zoomed browser page to 100%', async ({ orcaPage }) => {
    const formServer = await startBrowserFormServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const browserTab = await createBrowserTab(
        orcaPage,
        worktreeId,
        formServer.url('Zoom reset'),
        'Zoom Reset'
      )
      expect(browserTab?.id).toBeTruthy()
      await expect
        .poll(async () => readBrowserInputValue(orcaPage, browserTab!.id), { timeout: 5_000 })
        .not.toBeNull()

      const zoomModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'
      await orcaPage.evaluate(
        async ({ browserTabId, browserPageId, modifier }) => {
          const slot = document.querySelector(`[data-browser-overlay-tab-id="${browserTabId}"]`)
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          if (!webview) {
            throw new Error(`Missing webview for browser tab ${browserTabId}`)
          }
          window.dispatchEvent(
            new CustomEvent('orca:browser-page-zoom', {
              detail: { browserPageId, direction: 'in' }
            })
          )
          await webview.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: [modifier] })
          await webview.sendInputEvent({ type: 'keyUp', keyCode: '0', modifiers: [modifier] })
        },
        {
          browserTabId: browserTab!.id,
          browserPageId: browserTab!.pageId ?? browserTab!.id,
          modifier: zoomModifier
        }
      )
      await expect
        .poll(() =>
          orcaPage.evaluate((browserTabId) => {
            const slot = document.querySelector(`[data-browser-overlay-tab-id="${browserTabId}"]`)
            return (slot?.querySelector('webview') as Electron.WebviewTag | null)?.getZoomLevel()
          }, browserTab!.id)
        )
        .toBe(0)
    } finally {
      await formServer.close()
    }
  })

  test('reloading one browser tab does not adopt another tab zoom', async ({ orcaPage }) => {
    const [formServerA, formServerB] = await Promise.all([
      startBrowserFormServer(),
      startBrowserFormServer('localhost')
    ])
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const tabA = await createBrowserTab(orcaPage, worktreeId, formServerA.url('Zoom A'), 'Zoom A')
      const tabB = await createBrowserTab(orcaPage, worktreeId, formServerB.url('Zoom B'), 'Zoom B')
      expect(tabA?.id).toBeTruthy()
      expect(tabB?.id).toBeTruthy()
      for (const tab of [tabA, tabB]) {
        await expect
          .poll(async () => readBrowserInputValue(orcaPage, tab!.id), { timeout: 5_000 })
          .not.toBeNull()
      }

      const levels = await orcaPage.evaluate(
        async ({ tabAId, tabBId, pageBId }) => {
          const webviewFor = (id: string): Electron.WebviewTag => {
            const slot = document.querySelector(`[data-browser-overlay-tab-id="${id}"]`)
            const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
            if (!webview) {
              throw new Error(`Missing webview for browser tab ${id}`)
            }
            return webview
          }
          const webviewA = webviewFor(tabAId)
          const webviewB = webviewFor(tabBId)

          // Zoom only tab B through the real renderer zoom path (also writes the shared setting).
          for (let step = 0; step < 2; step += 1) {
            window.dispatchEvent(
              new CustomEvent('orca:browser-page-zoom', {
                detail: { browserPageId: pageBId, direction: 'in' }
              })
            )
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          const zoomedB = webviewB.getZoomLevel()
          const untouchedA = webviewA.getZoomLevel()

          await new Promise<void>((resolve) => {
            const onReady = (): void => {
              webviewA.removeEventListener('dom-ready', onReady)
              resolve()
            }
            webviewA.addEventListener('dom-ready', onReady)
            webviewA.reload()
          })

          return { zoomedB, untouchedA, reloadedA: webviewA.getZoomLevel() }
        },
        { tabAId: tabA!.id, tabBId: tabB!.id, pageBId: tabB!.pageId ?? tabB!.id }
      )

      expect(levels.zoomedB).toBeGreaterThan(0)
      expect(levels.untouchedA).toBe(0)
      // Regression: reasserting the shared default would drag tab A to tab B's zoom.
      expect(levels.reloadedA).toBe(0)
    } finally {
      await Promise.all([formServerA.close(), formServerB.close()])
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
