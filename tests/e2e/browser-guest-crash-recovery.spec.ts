import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../../src/renderer/src/components/browser-pane/browser-page-guest-recovery'
import {
  crashGuestRenderer,
  listRegisteredBrowserPages,
  readBrowserGuestState,
  readGuestProcessId,
  verifyBrowserWorktreeRetentionAndRecovery
} from './browser-guest-runtime-oracle'

type BrowserFixture = {
  browserTab: { id: string; activePageId: string }
  fixtureUrl: string
  worktreeId: string
}

async function createBrowserFixture(
  page: Page,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<BrowserFixture> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-browser-recovery-'))
  registerCleanup(async () => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })
  const fixturePath = path.join(fixtureDir, 'recovery.html')
  writeFileSync(
    fixturePath,
    '<!doctype html><html><head><title>Recovery fixture</title></head><body style="background:#fff"><h1 id="recovery-marker">painted-file-guest</h1><input id="recovery-state"></body></html>'
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
        title: 'Recovery fixture',
        activate: true
      }),
    { targetWorktreeId: worktreeId, targetUrl: fixtureUrl }
  )
  if (!browserTab?.activePageId) {
    throw new Error('Failed to create browser recovery fixture tab')
  }
  return {
    browserTab: { id: browserTab.id, activePageId: browserTab.activePageId },
    fixtureUrl,
    worktreeId
  }
}

async function readBrowserPageRecoveryState(
  page: Page,
  workspaceId: string,
  browserPageId: string
): Promise<{ loadErrorCode: number | null; url: string | null }> {
  return page.evaluate(
    ({ targetWorkspaceId, targetBrowserPageId }) => {
      const browserPage = window.__store
        ?.getState()
        .browserPagesByWorkspace[targetWorkspaceId]?.find(
          (entry) => entry.id === targetBrowserPageId
        )
      return {
        loadErrorCode: browserPage?.loadError?.code ?? null,
        url: browserPage?.url ?? null
      }
    },
    { targetWorkspaceId: workspaceId, targetBrowserPageId: browserPageId }
  )
}

test('browser chrome recovers a live registered file guest after renderer loss', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-file-guest',
      url: fixtureUrl
    })
  const before = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(before.webContentsId).not.toBeNull()
  const beforeProcessId = await readGuestProcessId(electronApp, before.webContentsId!)
  await expect
    .poll(
      async () =>
        (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.find(
          (tab) => tab.browserPageId === browserTab.activePageId
        ),
      { timeout: 10_000 }
    )
    .toMatchObject({ browserPageId: browserTab.activePageId, url: fixtureUrl })

  const crashDetails = await crashGuestRenderer(electronApp, before.webContentsId!)
  expect(['crashed', 'killed']).toContain(crashDetails.reason)

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-file-guest',
      url: fixtureUrl
    })
  const recovered = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(recovered.webContentsId).toBe(before.webContentsId)
  await expect
    .poll(() => readGuestProcessId(electronApp, recovered.webContentsId!), { timeout: 10_000 })
    .not.toBe(beforeProcessId)
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId), { timeout: 10_000 })
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })

  await orcaPage.evaluate(
    async ({ targetBrowserTabId, targetValue }) => {
      const overlay = document.querySelector(
        `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
      )
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag
      await webview.executeJavaScript(
        `document.querySelector('#recovery-state').value = ${JSON.stringify(targetValue)}`
      )
    },
    { targetBrowserTabId: browserTab.id, targetValue: 'unsaved-form-state' }
  )
  await orcaPage.evaluate((browserPageId) => {
    return window.api.browser.unregisterGuest({ browserPageId })
  }, browserTab.activePageId)
  await expect
    .poll(
      async () =>
        (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.some(
          (tab) => tab.browserPageId === browserTab.activePageId
        ) ?? false
    )
    .toBe(false)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('system:resumed')
  })
  await expect
    .poll(async () =>
      (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.find(
        (tab) => tab.browserPageId === browserTab.activePageId
      )
    )
    .toMatchObject({ browserPageId: browserTab.activePageId, url: fixtureUrl })
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const resumeRecovered = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(resumeRecovered.webContentsId).toBe(recovered.webContentsId)
  expect(resumeRecovered.formValue).toBe('unsaved-form-state')

  const backgroundTab = await orcaPage.evaluate(
    ({ targetWorktreeId }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, 'about:blank', {
        title: 'Background control',
        activate: false
      }),
    { targetWorktreeId: worktreeId }
  )
  expect(backgroundTab?.id).toBeTruthy()
  await expect
    .poll(() => readBrowserGuestState(orcaPage, backgroundTab!.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true })

  const beforeRendererReloadId = resumeRecovered.webContentsId
  await orcaPage.reload()
  await waitForActiveWorktree(orcaPage)
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const rendererReloaded = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(rendererReloaded.webContentsId).not.toBe(beforeRendererReloadId)

  await orcaPage.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, backgroundTab!.id)
  const hiddenBefore = await readBrowserGuestState(orcaPage, browserTab.id)
  const hiddenProcessId = await readGuestProcessId(electronApp, hiddenBefore.webContentsId!)
  await crashGuestRenderer(electronApp, hiddenBefore.webContentsId!)
  await expect
    .poll(() => readGuestProcessId(electronApp, hiddenBefore.webContentsId!), {
      timeout: 10_000
    })
    .not.toBe(hiddenProcessId)
  await orcaPage.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, browserTab.id)
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })

  await verifyBrowserWorktreeRetentionAndRecovery({
    browserTab,
    electronApp,
    fixtureUrl,
    page: orcaPage,
    worktreeId
  })
})

test('dom-ready ID loss waits for validation without reloading the guest', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })
  const before = await readBrowserGuestState(orcaPage, browserTab.id)

  await orcaPage.evaluate((targetBrowserTabId) => {
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    const webview = overlay?.querySelector('webview') as Electron.WebviewTag
    const getWebContentsId = webview.getWebContentsId.bind(webview)
    const reload = webview.reload.bind(webview)
    let failedReads = 2
    Object.defineProperty(webview, 'getWebContentsId', {
      configurable: true,
      value: () => {
        if (failedReads > 0) {
          failedReads -= 1
          throw new Error('guest detached')
        }
        webview.dataset.domReadyIdRestored = 'true'
        return getWebContentsId()
      }
    })
    Object.defineProperty(webview, 'reload', {
      configurable: true,
      value: () => {
        webview.dataset.recoveryReloadAttempted = 'true'
        reload()
      }
    })
    webview.dispatchEvent(new Event('dom-ready'))
  }, browserTab.id)

  await expect
    .poll(() =>
      orcaPage.evaluate(
        (targetBrowserTabId) =>
          document
            .querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`)
            ?.getAttribute('data-dom-ready-id-restored') ?? null,
        browserTab.id
      )
    )
    .toBe('true')
  await expect(
    orcaPage.locator(
      `[data-browser-overlay-tab-id="${browserTab.id}"] webview[data-recovery-reload-attempted]`
    )
  ).toHaveCount(0)
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-file-guest',
      url: fixtureUrl,
      webContentsId: before.webContentsId
    })
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })
})

test('explicit navigation repairs a recovery error without dom-ready churn', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })

  await orcaPage.evaluate(
    (browserPageId) => window.api.browser.unregisterGuest({ browserPageId }),
    browserTab.activePageId
  )
  await orcaPage.evaluate(
    ({ browserPageId, validatedUrl, recoveryErrorCode }) => {
      window.__store?.getState().updateBrowserPageState(browserPageId, {
        loading: false,
        loadError: {
          code: recoveryErrorCode,
          description: 'Recovery fixture error',
          validatedUrl
        }
      })
    },
    {
      browserPageId: browserTab.activePageId,
      validatedUrl: fixtureUrl,
      recoveryErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE
    }
  )
  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toMatchObject({ loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE })

  await electronApp.evaluate(({ ipcMain }) => {
    const testState = globalThis as typeof globalThis & {
      browserRecoveryValidationCalls?: number
    }
    testState.browserRecoveryValidationCalls = 0
    ipcMain.removeHandler('browser:isGuestRegistered')
    ipcMain.handle('browser:isGuestRegistered', () => {
      testState.browserRecoveryValidationCalls = (testState.browserRecoveryValidationCalls ?? 0) + 1
      return false
    })
  })
  await orcaPage.evaluate((targetBrowserTabId) => {
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    overlay?.querySelector('webview')?.dispatchEvent(new Event('dom-ready'))
  }, browserTab.id)
  await expect
    .poll(async () =>
      (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.some(
        (tab) => tab.browserPageId === browserTab.activePageId
      )
    )
    .toBe(false)

  const addressBar = orcaPage.locator(
    `[data-browser-overlay-tab-id="${browserTab.id}"] [data-orca-browser-address-bar="true"]`
  )
  let resolvePrecommitRequest: (() => void) | null = null
  const precommitRequest = new Promise<void>((resolve) => {
    resolvePrecommitRequest = resolve
  })
  let resolveCommittedRequest: (() => void) | null = null
  const committedRequest = new Promise<void>((resolve) => {
    resolveCommittedRequest = resolve
  })
  let resolveRedirectedRequest: (() => void) | null = null
  const redirectedRequest = new Promise<void>((resolve) => {
    resolveRedirectedRequest = resolve
  })
  const stalledServer = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/redirected' })
      response.end()
      return
    }
    if (request.url === '/redirected') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><body><h1 id="recovery-marker">painted-redirected-guest</h1></body></html>'
      )
      resolveRedirectedRequest?.()
      return
    }
    if (request.url === '/committed') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.write('<!doctype html><html><head><title>Committed stall</title></head><body>')
      resolveCommittedRequest?.()
      return
    }
    resolvePrecommitRequest?.()
  })
  await new Promise<void>((resolve, reject) => {
    stalledServer.once('error', reject)
    stalledServer.listen(0, '127.0.0.1', resolve)
  })
  registerPostElectronShutdownCleanup(async () => {
    stalledServer.closeAllConnections()
    await new Promise<void>((resolve) => {
      stalledServer.close(() => resolve())
    })
  })
  const stalledAddress = stalledServer.address()
  if (!stalledAddress || typeof stalledAddress === 'string') {
    throw new Error('Expected a local stalled server address')
  }
  const stalledOrigin = `http://127.0.0.1:${stalledAddress.port}`
  await addressBar.fill(`${stalledOrigin}/precommit`)
  await addressBar.press('Enter')
  await precommitRequest
  await orcaPage.evaluate((targetBrowserTabId) => {
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    const webview = overlay?.querySelector('webview')
    const inPageNavigation = Object.assign(new Event('did-navigate-in-page'), {
      isMainFrame: true,
      url: `${webview?.getAttribute('src') ?? 'about:blank'}#stale`
    })
    webview?.dispatchEvent(inPageNavigation)
    webview?.dispatchEvent(new Event('dom-ready'))
  }, browserTab.id)
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  expect(
    await electronApp.evaluate(() => {
      const testState = globalThis as typeof globalThis & {
        browserRecoveryValidationCalls?: number
      }
      return testState.browserRecoveryValidationCalls ?? 0
    })
  ).toBe(0)
  await expect
    .poll(async () =>
      (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.some(
        (tab) => tab.browserPageId === browserTab.activePageId
      )
    )
    .toBe(false)
  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toMatchObject({ loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE })

  const committedStallUrl = `${stalledOrigin}/committed`
  await addressBar.fill(committedStallUrl)
  await addressBar.press('Enter')
  await committedRequest
  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toEqual({ loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE, url: committedStallUrl })
  await expect(orcaPage.getByText('Recovery fixture error', { exact: true })).toBeVisible()
  expect(
    await electronApp.evaluate(() => {
      const testState = globalThis as typeof globalThis & {
        browserRecoveryValidationCalls?: number
      }
      return testState.browserRecoveryValidationCalls ?? 0
    })
  ).toBe(0)
  await expect
    .poll(async () =>
      (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.some(
        (tab) => tab.browserPageId === browserTab.activePageId
      )
    )
    .toBe(false)
  await addressBar.fill(fixtureUrl)
  await addressBar.press('Enter')

  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toMatchObject({ loadErrorCode: null, url: fixtureUrl })
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })
  expect(
    await electronApp.evaluate(() => {
      const testState = globalThis as typeof globalThis & {
        browserRecoveryValidationCalls?: number
      }
      return testState.browserRecoveryValidationCalls ?? 0
    })
  ).toBe(1)

  await orcaPage.evaluate(
    (browserPageId) => window.api.browser.unregisterGuest({ browserPageId }),
    browserTab.activePageId
  )
  await orcaPage.evaluate(
    ({ browserPageId, validatedUrl, recoveryErrorCode }) => {
      window.__store?.getState().updateBrowserPageState(browserPageId, {
        loading: false,
        loadError: {
          code: recoveryErrorCode,
          description: 'Recovery redirect fixture error',
          validatedUrl
        }
      })
    },
    {
      browserPageId: browserTab.activePageId,
      validatedUrl: fixtureUrl,
      recoveryErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE
    }
  )
  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toMatchObject({ loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE })
  await electronApp.evaluate(() => {
    const testState = globalThis as typeof globalThis & {
      browserRecoveryValidationCalls?: number
    }
    testState.browserRecoveryValidationCalls = 0
  })

  const redirectedUrl = `${stalledOrigin}/redirected`
  await addressBar.fill(`${stalledOrigin}/redirect`)
  await addressBar.press('Enter')
  await redirectedRequest

  await expect
    .poll(() => readBrowserPageRecoveryState(orcaPage, browserTab.id, browserTab.activePageId))
    .toMatchObject({ loadErrorCode: null, url: redirectedUrl })
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: redirectedUrl }] }
    })
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-redirected-guest',
      url: redirectedUrl
    })
  expect(
    await electronApp.evaluate(() => {
      const testState = globalThis as typeof globalThis & {
        browserRecoveryValidationCalls?: number
      }
      return testState.browserRecoveryValidationCalls ?? 0
    })
  ).toBe(1)
})

test('recovery error stays visible until toolbar retry repairs registration', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })

  await orcaPage.evaluate(
    (browserPageId) => window.api.browser.unregisterGuest({ browserPageId }),
    browserTab.activePageId
  )
  await electronApp.evaluate(({ BrowserWindow, ipcMain }) => {
    ipcMain.removeHandler('browser:isGuestRegistered')
    BrowserWindow.getAllWindows()[0]?.webContents.send('system:resumed')
  })

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          ({ workspaceId, browserPageId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[workspaceId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          { workspaceId: browserTab.id, browserPageId: browserTab.activePageId }
        ),
      { timeout: 10_000 }
    )
    .toBe(BROWSER_GUEST_RECOVERY_ERROR_CODE)

  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.handle('browser:isGuestRegistered', () => false)
  })
  await orcaPage
    .locator('[data-contextual-tour-target="browser-toolbar"]')
    .locator('button')
    .nth(2)
    .click()

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          ({ workspaceId, browserPageId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[workspaceId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          { workspaceId: browserTab.id, browserPageId: browserTab.activePageId }
        ),
      { timeout: 10_000 }
    )
    .toBeNull()
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })
})

test('attachment keeps recovery error until document readiness', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })

  await orcaPage.evaluate(
    ({ workspaceId, browserPageId, validatedUrl, recoveryErrorCode }) => {
      window.__store?.getState().updateBrowserPageState(browserPageId, {
        loading: false,
        loadError: {
          code: recoveryErrorCode,
          description: 'Recovery fixture error',
          validatedUrl
        }
      })
      const overlay = document.querySelector(`[data-browser-overlay-tab-id="${workspaceId}"]`)
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag
      Object.defineProperty(webview, 'reload', {
        configurable: true,
        value: () => webview.dispatchEvent(new Event('did-attach'))
      })
    },
    {
      workspaceId: browserTab.id,
      browserPageId: browserTab.activePageId,
      validatedUrl: fixtureUrl,
      recoveryErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE
    }
  )
  await orcaPage
    .locator('[data-contextual-tour-target="browser-toolbar"]')
    .locator('button')
    .nth(2)
    .click()
  const recoveryErrorCode = await orcaPage.evaluate(
    ({ workspaceId, browserPageId }) =>
      new Promise<number | null>((resolve) => {
        requestAnimationFrame(() => {
          resolve(
            window.__store
              ?.getState()
              .browserPagesByWorkspace[workspaceId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null
          )
        })
      }),
    { workspaceId: browserTab.id, browserPageId: browserTab.activePageId }
  )
  expect(recoveryErrorCode).toBe(BROWSER_GUEST_RECOVERY_ERROR_CODE)
})

test('minimized browser guest stays painted and registered after restore @headful', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })
  const before = await readBrowserGuestState(orcaPage, browserTab.id)

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.minimize()
  })
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) =>
        Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized())
      )
    )
    .toBe(true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.restore()
    window?.show()
  })

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const restored = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(restored.webContentsId).toBe(before.webContentsId)
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })
  const screenshotPath = testInfo.outputPath('browser-minimize-restore.png')
  await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('browser-minimize-restore', {
    path: screenshotPath,
    contentType: 'image/png'
  })
})
