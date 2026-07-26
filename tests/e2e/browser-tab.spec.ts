/**
 * E2E tests for the browser tab: creating browser tabs and state retention.
 *
 * User Prompt:
 * - Browser works and also retains state when switching tabs etc.
 */

import { test, expect } from './helpers/orca-app'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getBrowserTabs,
  getAllWorktreeIds,
  switchToOtherWorktree,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'

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

async function switchToTerminalTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal')
  }, worktreeId)
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

async function startBrowserFormServer(): Promise<{
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (label: string) => `http://127.0.0.1:${port}/${encodeURIComponent(label)}`,
    close: () => closeServer(server)
  }
}

async function startBrowserLinkServer(): Promise<{
  sourceUrl: string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const pathname = new URL(request.url ?? '/', origin).pathname
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (pathname === '/destination') {
      response.end(
        `<!doctype html><html><head><title>Linked destination</title></head><body>Destination <a id="return-link" href="${origin}/source">Return</a></body></html>`
      )
      return
    }
    if (pathname === '/frame-destination') {
      response.end(
        `<!doctype html><html><head><title>Frame destination</title></head><body>Frame destination <a id="return-link" href="${origin}/source">Return</a></body></html>`
      )
      return
    }
    if (pathname === '/frame-modifier-destination') {
      response.end(
        '<!doctype html><html><head><title>Frame modifier destination</title></head><body>Frame modifier destination</body></html>'
      )
      return
    }
    if (pathname === '/frame-middle-destination') {
      response.end(
        '<!doctype html><html><head><title>Frame middle destination</title></head><body>Frame middle destination</body></html>'
      )
      return
    }
    if (pathname === '/frame') {
      response.end(
        `<!doctype html><html><body><a style="display:block" id="frame-link" href="${origin}/frame-destination" target="_blank">Open frame destination</a><a style="display:block" id="frame-modifier-link" href="${origin}/frame-modifier-destination">Open frame modifier destination</a><a style="display:block" id="frame-middle-link" href="${origin}/frame-middle-destination">Open frame middle destination</a></body></html>`
      )
      return
    }
    if (pathname === '/modifier-destination') {
      response.end(
        '<!doctype html><html><head><title>Modifier destination</title></head><body>Modifier destination</body></html>'
      )
      return
    }
    if (pathname === '/middle-destination') {
      response.end(
        '<!doctype html><html><head><title>Middle-click destination</title></head><body>Middle-click destination</body></html>'
      )
      return
    }
    response.end(`
      <!doctype html>
      <html>
        <head><title>Source page</title></head>
        <body>
          <a id="external-link" href="${origin}/destination" target="_blank">Open destination</a>
          <a id="modifier-link" href="${origin}/modifier-destination">Open with modifier</a>
          <a id="middle-link" href="${origin}/middle-destination">Open with middle click</a>
          <a id="cancelled-link" href="${origin}/destination" target="_blank">Handle in page</a>
          <iframe id="link-frame" src="${origin}/frame" title="Embedded links"></iframe>
          <script>
            document.querySelector('#cancelled-link').addEventListener('click', (event) => {
              event.preventDefault()
              document.title = 'Click handled in page'
            })
          </script>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
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
    modifiers?: ('meta' | 'control')[]
    button?: 'left' | 'middle'
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

async function expectBrowserTabActive(
  page: Parameters<typeof getActiveWorktreeId>[0],
  title: string
): Promise<void> {
  const resolveTabId = (): Promise<string | null> =>
    page.locator('[data-tab-id]').evaluateAll((tabs, exactTitle) => {
      const tab = tabs.find((candidate) => candidate.textContent?.trim() === exactTitle)
      return tab?.getAttribute('data-tab-id') ?? null
    }, title)
  await expect.poll(resolveTabId, { timeout: 10_000 }).not.toBeNull()
  const tabId = await resolveTabId()
  expect(tabId).toBeTruthy()
  await expect(page.locator(`[data-browser-overlay-tab-id="${tabId}"]`)).toHaveCSS('opacity', '1')
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

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('creating a browser tab adds it and activates browser view', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const browserTabsBefore = await getBrowserTabs(orcaPage, worktreeId)

    await createBrowserTab(orcaPage, worktreeId)

    // Wait for the browser tab to appear in the store
    await expect
      .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(browserTabsBefore.length + 1)

    // The active tab type should switch to 'browser'
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('browser')
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab is created and active in the store', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await createBrowserTab(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')

    // Verify the browser tab exists in the store
    const browserTabs = await getBrowserTabs(orcaPage, worktreeId)
    expect(browserTabs.length).toBeGreaterThan(0)

    // The active browser tab should have a URL (even if it's about:blank or the default)
    const activeBrowserTabId = await orcaPage.evaluate(() => {
      const store = window.__store
      return store?.getState().activeBrowserTabId ?? null
    })
    expect(activeBrowserTabId).not.toBeNull()
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab retains state when switching to terminal and back', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await createBrowserTab(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')

    // Record the browser tab info
    const browserTabsBefore = await getBrowserTabs(orcaPage, worktreeId)
    expect(browserTabsBefore.length).toBeGreaterThan(0)
    const browserTabId = browserTabsBefore.at(-1)?.id
    expect(browserTabId).toBeTruthy()

    // Switch to the terminal view
    await switchToTerminalTab(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('terminal')

    // Switch back to browser tab
    await switchToBrowserTab(orcaPage, worktreeId, browserTabId!)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('browser')

    // The browser tab should still exist with the same ID
    const browserTabsAfter = await getBrowserTabs(orcaPage, worktreeId)
    const tabStillExists = browserTabsAfter.some((tab) => tab.id === browserTabId)
    expect(tabStillExists).toBe(true)
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

  test('plain links stay current while explicit new-tab gestures activate Orca tabs', async ({
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
      const baseTabCount = await orcaPage.locator('[data-tab-id]').count()
      await clickBrowserLink(orcaPage, sourceTab!.id, '#external-link')

      const sourceTabLocator = orcaPage.locator(`[data-tab-id="${sourceTab!.id}"]`)
      await expect(sourceTabLocator).toContainText('Linked destination', { timeout: 10_000 })
      await expect(orcaPage.locator('[data-tab-id]')).toHaveCount(baseTabCount)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#return-link')
      await expect(sourceTabLocator).toContainText('Source page', { timeout: 10_000 })
      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-link', {
        frameSelector: '#link-frame'
      })
      await expect(sourceTabLocator).toContainText('Frame destination', { timeout: 10_000 })
      await expect(orcaPage.locator('[data-tab-id]')).toHaveCount(baseTabCount)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#return-link')
      await expect(sourceTabLocator).toContainText('Source page', { timeout: 10_000 })

      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-modifier-link', {
        frameSelector: '#link-frame',
        modifiers: process.platform === 'darwin' ? ['meta'] : ['control']
      })
      await expectBrowserTabActive(orcaPage, 'Frame modifier destination')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)
      await clickBrowserLink(orcaPage, sourceTab!.id, '#frame-middle-link', {
        button: 'middle',
        frameSelector: '#link-frame'
      })
      await expectBrowserTabActive(orcaPage, 'Frame middle destination')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#modifier-link', {
        modifiers: process.platform === 'darwin' ? ['meta'] : ['control']
      })
      await expectBrowserTabActive(orcaPage, 'Modifier destination')
      await switchToBrowserTab(orcaPage, worktreeId, sourceTab!.id)

      const tabCountBeforeCancelledClick = await orcaPage.locator('[data-tab-id]').count()
      await clickBrowserLink(orcaPage, sourceTab!.id, '#cancelled-link')
      await expect(
        orcaPage.locator('[data-tab-id]').filter({ hasText: 'Click handled in page' })
      ).toBeVisible({ timeout: 10_000 })
      await expect(orcaPage.locator('[data-tab-id]')).toHaveCount(tabCountBeforeCancelledClick)

      await clickBrowserLink(orcaPage, sourceTab!.id, '#middle-link', { button: 'middle' })
      await expectBrowserTabActive(orcaPage, 'Middle-click destination')
      await expect
        .poll(() => electronApp.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), {
          timeout: 5_000
        })
        .toBe(baseWindowCount)
    } finally {
      await linkServer.close()
    }
  })

  /**
   * User Prompt:
   * - Browser works and also retains state when switching tabs etc.
   */
  test('browser tab retains state when switching worktrees and back', async ({ orcaPage }) => {
    const allWorktreeIds = await getAllWorktreeIds(orcaPage)
    if (allWorktreeIds.length < 2) {
      test.skip(true, 'Need at least 2 worktrees to test worktree switching')
    }

    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await createBrowserTab(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('browser')

    const browserTabsBefore = await getBrowserTabs(orcaPage, worktreeId)
    expect(browserTabsBefore.length).toBeGreaterThan(0)

    // Switch to a different worktree via the store
    const otherId = await switchToOtherWorktree(orcaPage, worktreeId)
    expect(otherId).not.toBeNull()
    await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 }).toBe(otherId)

    // Switch back to the original worktree
    await switchToWorktree(orcaPage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 })
      .toBe(worktreeId)

    // Browser tabs should still be preserved
    const browserTabsAfter = await getBrowserTabs(orcaPage, worktreeId)
    expect(browserTabsAfter.length).toBe(browserTabsBefore.length)
  })
})
