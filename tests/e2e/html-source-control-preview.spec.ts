import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'

test('previews untracked HTML clicked in Source Control', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const root = await orcaPage.evaluate(
    (id) => window.__store?.getState().getKnownWorktreeById(id)?.path,
    worktreeId
  )
  if (!root) {
    throw new Error('Active workspace missing')
  }
  const name = 'source-control-preview.html'
  const filePath = path.join(root, name)
  const url = pathToFileURL(filePath).href
  writeFileSync(filePath, '<title>HTML preview</title><h1>Rendered from Source Control</h1>')
  await orcaPage.evaluate(() => {
    window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  })
  const row = orcaPage.locator(`[data-source-control-path="${name}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  await expect(
    orcaPage.getByRole('button', { name: 'Open source file', exact: true })
  ).toBeVisible()
  await expect(orcaPage.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect
    .poll(() =>
      electronApp.evaluate(async ({ webContents }, fileUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fileUrl)
        return guest?.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
      }, url)
    )
    .toBe('Rendered from Source Control')
  await orcaPage.screenshot({ path: testInfo.outputPath('html-source-control-preview.png') })
})

test('previews HTML clicked under Committed on branch', async ({
  electronApp,
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'html-branch-preview')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const name = 'committed-preview.html'
  const filePath = path.join(fixture.worktreePath, name)
  const url = pathToFileURL(filePath).href
  writeFileSync(filePath, '<title>Committed HTML</title><h1>Rendered from branch changes</h1>')
  for (const args of [
    ['add', '--', name],
    ['commit', '-m', 'Add HTML preview fixture']
  ]) {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: fixture.worktreePath,
      stdio: 'pipe'
    })
    if (result.code !== 0) {
      throw new Error(result.stderr || 'Failed to prepare committed HTML fixture')
    }
  }
  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  await orcaPage.evaluate(() => {
    window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
  })
  const row = orcaPage.locator(
    `[data-source-control-area="branch"][data-source-control-path="${name}"]`
  )
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  await expect(
    orcaPage.getByRole('button', { name: 'Open source file', exact: true })
  ).toBeVisible()
  await expect(orcaPage.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect
    .poll(() =>
      electronApp.evaluate(async ({ webContents }, fileUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fileUrl)
        return guest?.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
      }, url)
    )
    .toBe('Rendered from branch changes')
  await orcaPage.screenshot({ path: testInfo.outputPath('html-committed-branch-preview.png') })
})
