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

type BrowserAnnotationSeed = {
  id: string
  comment: string
  url: string
  title: string
  label: string
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

async function readBrowserAnnotationOverlayCount(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string
): Promise<number> {
  return page.evaluate(async (targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    return webview
      ? await webview.executeJavaScript(
          'document.querySelectorAll("[data-orca-browser-annotation-overlay]").length'
        )
      : -1
  }, browserTabId)
}

async function readBrowserAnnotationMarkerIds(
  page: Parameters<typeof getActiveWorktreeId>[0],
  browserTabId: string
): Promise<string[] | null> {
  return page.evaluate((targetBrowserTabId) => {
    const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
      (candidate) => candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
    )
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    const rawMarkerIds = webview?.getAttribute('data-orca-browser-annotation-marker-ids')
    if (!rawMarkerIds) {
      return null
    }
    try {
      const markerIds = JSON.parse(rawMarkerIds)
      return Array.isArray(markerIds) && markerIds.every((markerId) => typeof markerId === 'string')
        ? markerIds
        : null
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

async function addBrowserAnnotations(
  page: Parameters<typeof getActiveWorktreeId>[0],
  pageId: string,
  annotations: BrowserAnnotationSeed[]
): Promise<void> {
  await page.evaluate(
    ({ targetPageId, targetAnnotations }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Browser store is unavailable')
      }

      for (const annotation of targetAnnotations) {
        store.getState().addBrowserPageAnnotation({
          id: annotation.id,
          browserPageId: targetPageId,
          comment: annotation.comment,
          intent: 'change',
          priority: 'important',
          createdAt: new Date().toISOString(),
          payload: {
            page: {
              sanitizedUrl: annotation.url,
              title: annotation.title,
              viewportWidth: 1280,
              viewportHeight: 720,
              scrollX: 0,
              scrollY: 0,
              devicePixelRatio: 1,
              capturedAt: new Date().toISOString()
            },
            target: {
              tagName: 'button',
              selector: '#q',
              textSnippet: annotation.label,
              htmlSnippet: '<input id="q">',
              attributes: {},
              accessibility: {
                role: 'textbox',
                accessibleName: `${annotation.label} marker`,
                ariaLabel: null,
                ariaLabelledBy: null
              },
              rectViewport: { x: 10, y: 10, width: 100, height: 30 },
              rectPage: { x: 10, y: 10, width: 100, height: 30 },
              computedStyles: {
                display: 'block',
                position: 'static',
                width: '100px',
                height: '30px',
                margin: '0',
                padding: '0',
                color: 'black',
                backgroundColor: 'white',
                border: '0',
                borderRadius: '0',
                fontFamily: 'sans-serif',
                fontSize: '16px',
                fontWeight: '400',
                lineHeight: 'normal',
                textAlign: 'left',
                zIndex: 'auto'
              }
            },
            nearbyText: [],
            ancestorPath: [],
            screenshot: null
          }
        })
      }
    },
    { targetPageId: pageId, targetAnnotations: annotations }
  )
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

  test('browser annotations survive navigation without stale guest markers', async ({
    orcaPage
  }, testInfo) => {
    const server = await startBrowserFormServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const pageA = server.url('Page A')
      const pageB = server.url('Page B')
      const browserTab = await createBrowserTab(orcaPage, worktreeId, pageA, 'Annotations')
      expect(browserTab?.id).toBeTruthy()
      expect(browserTab?.pageId).toBeTruthy()
      const pageAAnnotations = Array.from({ length: 20 }, (_, index) => ({
        id: `page-a-annotation-${index}`,
        comment: `Page A feedback ${index}`,
        url: pageA,
        title: 'Page A',
        label: `Page A ${index}`
      }))
      const pageBAnnotationId = 'page-b-annotation'

      await addBrowserAnnotations(orcaPage, browserTab!.pageId!, pageAAnnotations)
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(
              (targetPageId) =>
                window.__store?.getState().browserAnnotationsByPageId[targetPageId]?.length ?? -1,
              browserTab!.pageId
            ),
          { timeout: 5_000 }
        )
        .toBe(20)
      await expect(orcaPage.locator('body')).toContainText('Page A feedback 19')
      await expect
        .poll(async () => readBrowserAnnotationMarkerIds(orcaPage, browserTab!.id))
        .toEqual(pageAAnnotations.map(({ id }) => id))
      await expect
        .poll(async () => readBrowserAnnotationOverlayCount(orcaPage, browserTab!.id))
        .toBe(1)

      await orcaPage.evaluate(
        async ({ targetBrowserTabId, targetUrl }) => {
          const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
            (candidate) =>
              candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
          )
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          if (!webview) {
            throw new Error('Missing browser webview')
          }
          await webview.executeJavaScript(`location.href = ${JSON.stringify(targetUrl)}`)
        },
        { targetBrowserTabId: browserTab!.id, targetUrl: pageB }
      )
      await expect
        .poll(async () =>
          orcaPage.evaluate(async (targetBrowserTabId) => {
            const slot = [...document.querySelectorAll('[data-browser-overlay-tab-id]')].find(
              (candidate) =>
                candidate.getAttribute('data-browser-overlay-tab-id') === targetBrowserTabId
            )
            const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
            return webview ? await webview.executeJavaScript('window.location.href') : null
          }, browserTab!.id)
        )
        .toBe(pageB)
      await expect(orcaPage.locator('body')).toContainText('Page A feedback 19')
      await expect
        .poll(async () => readBrowserAnnotationOverlayCount(orcaPage, browserTab!.id))
        .toBe(0)
      await addBrowserAnnotations(orcaPage, browserTab!.pageId!, [
        {
          id: pageBAnnotationId,
          comment: 'Page B feedback',
          url: pageB,
          title: 'Page B',
          label: 'Page B'
        }
      ])
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(
              (targetPageId) =>
                window.__store?.getState().browserAnnotationsByPageId[targetPageId]?.length ?? -1,
              browserTab!.pageId
            ),
          { timeout: 5_000 }
        )
        .toBe(20)
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(
              ({ targetPageId, targetAnnotationId }) =>
                (window.__store?.getState().browserAnnotationsByPageId[targetPageId] ?? []).some(
                  ({ id }) => id === targetAnnotationId
                ),
              { targetPageId: browserTab!.pageId, targetAnnotationId: pageBAnnotationId }
            ),
          { timeout: 5_000 }
        )
        .toBe(true)
      await expect(orcaPage.locator('body')).toContainText('Page A feedback 19')
      await expect(orcaPage.locator('body')).toContainText('Page B feedback')
      await expect
        .poll(async () => readBrowserAnnotationMarkerIds(orcaPage, browserTab!.id))
        .toEqual([pageBAnnotationId])
      await expect
        .poll(async () => readBrowserAnnotationOverlayCount(orcaPage, browserTab!.id))
        .toBe(1)
      await orcaPage.screenshot({
        path: testInfo.outputPath('browser-annotations-after-navigation.png')
      })
      await testInfo.attach('browser-annotations-after-navigation.png', {
        path: testInfo.outputPath('browser-annotations-after-navigation.png'),
        contentType: 'image/png'
      })
    } finally {
      await server.close()
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
