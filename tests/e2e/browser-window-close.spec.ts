import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

async function openFixtureTab(
  page: Page,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<{ tabId: string }> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-browser-window-close-'))
  registerCleanup(async () => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })
  const fixturePath = path.join(fixtureDir, 'close.html')
  writeFileSync(
    fixturePath,
    '<!doctype html><html><head><title>Close fixture</title></head><body><h1 id="close-marker">close-fixture</h1></body></html>'
  )
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  if (!worktreeId) {
    throw new Error('Expected an active worktree')
  }
  const tab = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Close fixture',
        activate: true
      }),
    { targetWorktreeId: worktreeId, targetUrl: pathToFileURL(fixturePath).href }
  )
  if (!tab) {
    throw new Error('Failed to create the browser fixture tab')
  }
  // Why the catch here only: the guest may not exist or have loaded yet while this polls.
  await expect
    .poll(
      () =>
        runInGuest(page, tab.id, `document.querySelector('#close-marker')?.textContent`).catch(
          () => null
        ),
      { timeout: 10_000 }
    )
    .toBe('close-fixture')
  return { tabId: tab.id }
}

// Why executeJavaScript: it runs in the page's own world, where the guest preload replaced window.close.
async function runInGuest(page: Page, tabId: string, script: string): Promise<unknown> {
  return page.evaluate(
    async ({ targetTabId, targetScript }) => {
      const webview = document
        .querySelector(`[data-browser-overlay-tab-id="${targetTabId}"]`)
        ?.querySelector<Electron.WebviewTag>('webview')
      if (!webview) {
        throw new Error(`No webview for browser tab ${targetTabId}`)
      }
      return webview.executeJavaScript(targetScript)
    },
    { targetTabId: tabId, targetScript: script }
  )
}

test('a page that calls window.close() closes its browser tab', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { tabId } = await openFixtureTab(orcaPage, registerPostElectronShutdownCleanup)
  const tab = orcaPage.locator(`[data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible()

  await runInGuest(orcaPage, tabId, 'window.close()')

  await expect(tab).toHaveCount(0, { timeout: 10_000 })
})

test('a page that navigated keeps its tab when it calls window.close()', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { tabId } = await openFixtureTab(orcaPage, registerPostElectronShutdownCleanup)
  expect(
    await runInGuest(orcaPage, tabId, `history.pushState({}, '', '#next'); history.length`)
  ).toBe(2)

  await runInGuest(orcaPage, tabId, 'window.close()')

  // Why a fixed wait: this asserts that nothing happens, so there is no event to poll for.
  await orcaPage.waitForTimeout(1_000)
  await expect(orcaPage.locator(`[data-tab-id="${tabId}"]`)).toBeVisible()
})
