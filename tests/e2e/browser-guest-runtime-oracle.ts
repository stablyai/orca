import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { switchToOtherWorktree, switchToWorktree } from './helpers/store'

export type BrowserGuestState = {
  chromePresent: boolean
  formValue: string | null
  marker: string | null
  url: string | null
  webContentsId: number | null
}

type RuntimeResponse = {
  ok: boolean
  result?: { tabs?: { browserPageId: string; url: string }[] }
}

export async function readGuestProcessId(
  electronApp: ElectronApplication,
  webContentsId: number
): Promise<number | null> {
  return electronApp.evaluate(({ webContents }, targetId) => {
    const guest = webContents.fromId(targetId)
    return guest && !guest.isDestroyed() ? guest.getOSProcessId() : null
  }, webContentsId)
}

export async function readBrowserGuestState(
  page: Page,
  browserTabId: string
): Promise<BrowserGuestState> {
  return page.evaluate(async (targetBrowserTabId) => {
    const chromePresent = Boolean(document.querySelector(`[data-tab-id="${targetBrowserTabId}"]`))
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return {
        chromePresent,
        formValue: null,
        marker: null,
        url: null,
        webContentsId: null
      }
    }
    try {
      const webContentsId = webview.getWebContentsId()
      const guest = (await webview.executeJavaScript(`({
        formValue: document.querySelector('#recovery-state')?.value ?? null,
        marker: document.querySelector('#recovery-marker')?.textContent ?? null,
        url: location.href
      })`)) as { formValue: string | null; marker: string | null; url: string }
      return { chromePresent, ...guest, webContentsId }
    } catch {
      return {
        chromePresent,
        formValue: null,
        marker: null,
        url: null,
        webContentsId: null
      }
    }
  }, browserTabId)
}

export async function listRegisteredBrowserPages(
  page: Page,
  worktreeId: string
): Promise<RuntimeResponse> {
  return page.evaluate(
    (targetWorktreeId) =>
      window.api.runtime.call({
        method: 'browser.tabList',
        params: { worktree: `id:${targetWorktreeId}` }
      }),
    worktreeId
  ) as Promise<RuntimeResponse>
}

export async function crashGuestRenderer(
  electronApp: ElectronApplication,
  webContentsId: number
): Promise<Electron.RenderProcessGoneDetails> {
  return electronApp.evaluate(async ({ webContents }, targetId) => {
    const guest = webContents.fromId(targetId)
    if (!guest) {
      throw new Error(`Missing guest webContents ${targetId}`)
    }
    return new Promise<Electron.RenderProcessGoneDetails>((resolve) => {
      guest.once('render-process-gone', (_event, details) => resolve(details))
      guest.forcefullyCrashRenderer()
    })
  }, webContentsId)
}

export async function verifyBrowserWorktreeRetentionAndRecovery({
  browserTab,
  electronApp,
  fixtureUrl,
  page,
  worktreeId
}: {
  browserTab: { id: string; activePageId: string }
  electronApp: ElectronApplication
  fixtureUrl: string
  page: Page
  worktreeId: string
}): Promise<void> {
  await page.evaluate(
    async ({ targetBrowserTabId, targetValue }) => {
      const overlay = document.querySelector(
        `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
      )
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag
      await webview.executeJavaScript(
        `document.querySelector('#recovery-state').value = ${JSON.stringify(targetValue)}`
      )
    },
    {
      targetBrowserTabId: browserTab.id,
      targetValue: 'retained-across-worktree-switch'
    }
  )
  const parkedBefore = await readBrowserGuestState(page, browserTab.id)
  const parkedProcessId = await readGuestProcessId(electronApp, parkedBefore.webContentsId!)
  await expect.poll(() => isBrowserPagePaneMounted(page, browserTab.activePageId)).toBe(true)
  const otherWorktreeId = await switchToOtherWorktree(page, worktreeId)
  expect(otherWorktreeId).not.toBeNull()
  await expect.poll(() => isBrowserPagePaneMounted(page, browserTab.activePageId)).toBe(false)
  await expect
    .poll(() => readBrowserGuestState(page, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      formValue: 'retained-across-worktree-switch',
      marker: 'painted-file-guest',
      url: fixtureUrl,
      webContentsId: parkedBefore.webContentsId
    })
  await expect
    .poll(
      async () =>
        (await listRegisteredBrowserPages(page, worktreeId)).result?.tabs?.find(
          (tab) => tab.browserPageId === browserTab.activePageId
        ),
      { timeout: 10_000 }
    )
    .toMatchObject({ browserPageId: browserTab.activePageId, url: fixtureUrl })
  expect(await readGuestProcessId(electronApp, parkedBefore.webContentsId!)).toBe(parkedProcessId)

  await switchToWorktree(page, worktreeId)
  await page.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, browserTab.id)
  await expect.poll(() => isBrowserPagePaneMounted(page, browserTab.activePageId)).toBe(true)
  await expect
    .poll(() => readBrowserGuestState(page, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      formValue: 'retained-across-worktree-switch',
      marker: 'painted-file-guest',
      url: fixtureUrl,
      webContentsId: parkedBefore.webContentsId
    })

  await switchToWorktree(page, otherWorktreeId!)
  await expect.poll(() => isBrowserPagePaneMounted(page, browserTab.activePageId)).toBe(false)
  await crashGuestRenderer(electronApp, parkedBefore.webContentsId!)
  await switchToWorktree(page, worktreeId)
  await page.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, browserTab.id)
  await expect.poll(() => isBrowserPagePaneMounted(page, browserTab.activePageId)).toBe(true)
  await expect
    .poll(() => readBrowserGuestState(page, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const parkedRecovered = await readBrowserGuestState(page, browserTab.id)
  expect(parkedRecovered.webContentsId).toBe(parkedBefore.webContentsId)
  await expect
    .poll(() => readGuestProcessId(electronApp, parkedRecovered.webContentsId!))
    .not.toBe(parkedProcessId)
}

async function isBrowserPagePaneMounted(page: Page, browserPageId: string): Promise<boolean> {
  return page.evaluate(
    (targetBrowserPageId) =>
      Boolean(document.querySelector(`[data-browser-page-pane-id="${targetBrowserPageId}"]`)),
    browserPageId
  )
}
