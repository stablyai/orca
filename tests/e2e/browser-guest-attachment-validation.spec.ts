import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

type BrowserFixture = {
  browserTab: { activePageId: string; id: string }
  fixtureUrl: string
}

async function createBrowserFixture(
  page: Page,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<BrowserFixture> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-browser-attachment-'))
  registerCleanup(async () => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })
  const fixturePath = path.join(fixtureDir, 'attachment.html')
  writeFileSync(
    fixturePath,
    '<!doctype html><html><body style="background:#fff"><h1 id="attachment-marker">painted-attachment-guest</h1></body></html>'
  )
  const fixtureUrl = pathToFileURL(fixturePath).href
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  if (!worktreeId) {
    throw new Error('Expected an active worktree')
  }
  const browserTab = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Attachment fixture',
        activate: true
      }),
    { targetWorktreeId: worktreeId, targetUrl: fixtureUrl }
  )
  if (!browserTab?.activePageId) {
    throw new Error('Failed to create browser attachment fixture tab')
  }
  return {
    browserTab: { activePageId: browserTab.activePageId, id: browserTab.id },
    fixtureUrl
  }
}

async function readGuestState(page: Page, browserTabId: string) {
  return page.evaluate(async (targetBrowserTabId) => {
    const chromePresent = Boolean(document.querySelector(`[data-tab-id="${targetBrowserTabId}"]`))
    const webview = document.querySelector(
      `[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`
    ) as Electron.WebviewTag | null
    if (!webview) {
      return { chromePresent, marker: null, url: null, webContentsId: null }
    }
    try {
      const webContentsId = webview.getWebContentsId()
      const guest = (await webview.executeJavaScript(`({
        marker: document.querySelector('#attachment-marker')?.textContent ?? null,
        url: location.href
      })`)) as { marker: string | null; url: string }
      return { chromePresent, ...guest, webContentsId }
    } catch {
      return { chromePresent, marker: null, url: null, webContentsId: null }
    }
  }, browserTabId)
}

test('resume validation waits for an attaching guest without replacing it', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-attachment-guest', url: fixtureUrl })
  const before = await readGuestState(orcaPage, browserTab.id)
  expect(before.webContentsId).not.toBeNull()

  await orcaPage.evaluate((targetBrowserTabId) => {
    const webview = document.querySelector(
      `[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`
    ) as Electron.WebviewTag
    const getWebContentsId = webview.getWebContentsId.bind(webview)
    let failedReads = 1
    webview.dataset.attachingGuestIdentity = 'original'
    Object.defineProperty(webview, 'getWebContentsId', {
      configurable: true,
      value: () => {
        if (failedReads > 0) {
          failedReads -= 1
          webview.dataset.attachingGuestForcedRead = 'true'
          throw new Error('guest still attaching')
        }
        webview.dataset.attachingGuestSuccessfulRead = 'true'
        return getWebContentsId()
      }
    })
  }, browserTab.id)

  await orcaPage.evaluate(
    (browserPageId) => window.api.browser.unregisterGuest({ browserPageId }),
    browserTab.activePageId
  )

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('system:resumed')
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (targetBrowserTabId) =>
          document
            .querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`)
            ?.getAttribute('data-attaching-guest-forced-read') ?? null,
        browserTab.id
      )
    )
    .toBe('true')
  await orcaPage.evaluate((targetBrowserTabId) => {
    document
      .querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`)
      ?.dispatchEvent(new Event('dom-ready'))
  }, browserTab.id)
  await expect
    .poll(() =>
      orcaPage.evaluate((targetBrowserTabId) => {
        const webview = document.querySelector(
          `[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`
        ) as Electron.WebviewTag | null
        return {
          forcedRead: webview?.dataset.attachingGuestForcedRead ?? null,
          identity: webview?.dataset.attachingGuestIdentity ?? null,
          successfulRead: webview?.dataset.attachingGuestSuccessfulRead ?? null
        }
      }, browserTab.id)
    )
    .toEqual({ forcedRead: 'true', identity: 'original', successfulRead: 'true' })

  await expect
    .poll(() => readGuestState(orcaPage, browserTab.id))
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-attachment-guest',
      url: fixtureUrl,
      webContentsId: before.webContentsId
    })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ browserPageId, webContentsId }) =>
          window.api.browser.isGuestRegistered({ browserPageId, webContentsId }),
        { browserPageId: browserTab.activePageId, webContentsId: before.webContentsId! }
      )
    )
    .toBe(true)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ workspaceId, browserPageId }) =>
          window.__store
            ?.getState()
            .browserPagesByWorkspace[workspaceId]?.find((page) => page.id === browserPageId)
            ?.loadError?.code ?? null,
        { workspaceId: browserTab.id, browserPageId: browserTab.activePageId }
      )
    )
    .toBeNull()
})
