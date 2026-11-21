import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import 'node:http'

import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from '../../desktop/electron-fixtures/orca-app'
import { type Page, expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree
} from '../../desktop/renderer-probes/store'
import '../../../../src/renderer/src/components/browser-pane/host-guest/recovery/browser-page-guest-recovery'

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
