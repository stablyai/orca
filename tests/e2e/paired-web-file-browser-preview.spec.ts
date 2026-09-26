import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'

/** Map the visible browser workspace to its page on the paired server. */
async function readServerBrowserPageId(
  page: Page,
  worktreeId: string,
  fileName: string
): Promise<string | null> {
  return page.evaluate(
    ({ worktreeId, fileName }) => {
      const state = window.__store?.getState()
      const workspace = state?.browserTabsByWorktree[worktreeId]?.find((tab) =>
        tab.url.endsWith(fileName)
      )
      const activePageId = workspace?.activePageId
      return activePageId
        ? (state?.remoteBrowserPageHandlesByPageId[activePageId]?.remotePageId ?? null)
        : null
    },
    { worktreeId, fileName }
  )
}

test.skip(
  process.env.ORCA_E2E_WEB_CLIENT !== '1',
  'Run with ORCA_E2E_WEB_CLIENT=1 so the paired web client is built'
)

test('opens a server worktree HTML file from the paired web explorer', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fileName = `paired-web-preview-${randomUUID()}.html`
  const filePath = path.join(testRepoPath, fileName)
  const heading = `Preview loaded on the server ${fileName}`
  writeFileSync(filePath, `<html><body><h1>${heading}</h1></body></html>`)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedWebClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedWebClient(host.app, host.offer)
    const page = client.page
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repoPath)?.id ?? null,
            testRepoPath
          ),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const selectedWorktreeId = await page.evaluate((repoPath) => {
      const state = window.__store?.getState()
      const worktree = state?.allWorktrees().find((candidate) => candidate.path === repoPath)
      if (!state || !worktree) {
        throw new Error('Paired web worktree unavailable')
      }
      const environmentId = state.runtimeEnvironments[0]?.id
      if (!environmentId) {
        throw new Error('Paired web runtime unavailable')
      }
      state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
      return worktree.id
    }, testRepoPath)

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = window.__store?.getState()
            const environmentId = state?.runtimeEnvironments[0]?.id
            return environmentId
              ? (state.runtimeStatusByEnvironmentId
                  .get(environmentId)
                  ?.status?.capabilities?.includes('browser.screencast.v1') ?? false)
              : false
          }),
        { timeout: 30_000 }
      )
      .toBe(true)

    await openFileExplorer(page)
    const fileRow = page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await expect(fileRow).toBeVisible({ timeout: 30_000 })
    await fileRow.click({ button: 'right' })
    const openInBrowserItem = page.getByRole('menuitem', { name: 'Open in Orca Browser' })
    await expect(openInBrowserItem).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('before-file-open.png'),
      clip: { x: 1_000, y: 240, width: 430, height: 330 }
    })
    await openInBrowserItem.click()
    await expect(page.locator('[data-tab-id]').filter({ hasText: fileName })).toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByTestId('remote-browser-frame')).toBeVisible({ timeout: 30_000 })

    await expect
      .poll(() => readServerBrowserPageId(page, selectedWorktreeId, fileName), { timeout: 30_000 })
      .toBeTruthy()
    const pageId = await readServerBrowserPageId(page, selectedWorktreeId, fileName)
    if (!pageId) {
      throw new Error('Server browser page did not reach paired web')
    }
    await expect
      .poll(async () => {
        const response = await host.client.call<{ snapshot: string }>('browser.snapshot', {
          worktree: `id:${selectedWorktreeId}`,
          page: pageId
        })
        return response.result.snapshot
      })
      .toContain(heading)
    await expect(page.getByTestId('remote-browser-frame')).toHaveJSProperty('complete', true)
    await expect
      .poll(() =>
        page
          .getByTestId('remote-browser-frame')
          .evaluate((frame) => (frame instanceof HTMLImageElement ? frame.naturalWidth : 0))
      )
      .toBeGreaterThan(0)
    await page.screenshot({
      path: testInfo.outputPath('after-file-open.png'),
      clip: { x: 280, y: 0, width: 620, height: 420 }
    })
  } finally {
    await client?.dispose()
    await host.dispose()
    rmSync(filePath, { force: true })
  }
})
