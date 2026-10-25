import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { expect, test } from './helpers/source-control-generation-app'
import { waitForSessionReady } from './helpers/store'

async function survivingWindow(app: ElectronApplication, first: Page): Promise<Page> {
  const known = new Set(app.windows())
  expect(await first.evaluate(() => window.api.ui.openRuntimeClientWindow())).toEqual({ ok: true })
  await expect
    .poll(() =>
      app.windows().some((page) => !known.has(page) && /\/index\.html(?:[?#]|$)/.test(page.url()))
    )
    .toBe(true)
  const page = app
    .windows()
    .find((candidate) => !known.has(candidate) && /\/index\.html(?:[?#]|$)/.test(candidate.url()))
  if (!page) {
    throw new Error('Missing native window')
  }
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
  const nativeWindow = await app.browserWindow(first)
  await nativeWindow.evaluate((window) => window.close())
  await expect.poll(() => first.isClosed()).toBe(true)
  return page
}

test('a surviving native window observes external git init for a folder project', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(120_000)
  await orcaPage.evaluate(() => {
    void window.__store?.getState().updateSettings({ uiLanguage: 'en' })
  })
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.uiLanguage))
    .toBe('en')
  const folderPath = realpathSync(mkdtempSync(join(tmpdir(), 'orca-native-folder-')))
  registerPostElectronShutdownCleanup(() => rm(folderPath, { recursive: true, force: true }))
  const repoId = await orcaPage.evaluate(async (path) => {
    const result = await window.api.repos.add({ path, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, folderPath)
  const page = await survivingWindow(electronApp, orcaPage)
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__store?.getState().repos.find((repo) => repo.id === id)?.kind,
        repoId
      )
    )
    .toBe('folder')
  await page.evaluate(() => window.__store?.getState().setGroupBy('repo'))
  const header = page.locator(`[data-worktree-sidebar] [data-repo-header-id="${repoId}"]`)
  await expect(header).toBeVisible()
  await header.hover()
  await expect(header.getByRole('button', { name: /^Create workspace for / })).toBeVisible()
  const git = await runProcess({ program: 'git', args: ['init', folderPath] })
  expect(git.code, git.stderr).toBe(0)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.__store?.getState().repos.find((repo) => repo.id === id)?.kind,
          repoId
        ),
      { timeout: 30_000 }
    )
    .toBe('git')
  await header.hover()
  await expect(header.getByRole('button', { name: /^Create new worktree for / })).toBeVisible()
  await expect(header.getByRole('button', { name: /^Create workspace for / })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('folder-to-git.png') })
})

test('a surviving native window receives external worktree and git metadata changes', async ({
  electronApp,
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(120_000)
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'orca-native-external-')))
  const external = join(parent, 'worktree')
  registerPostElectronShutdownCleanup(() => rm(parent, { recursive: true, force: true }))
  const page = await survivingWindow(electronApp, orcaPage)
  await page.evaluate(() => {
    document.documentElement.dataset.nativeStructureChanges = '0'
    document.documentElement.dataset.nativeStatusChanges = '0'
    window.api.worktrees.onChanged(() => {
      document.documentElement.dataset.nativeStructureChanges = String(
        Number(document.documentElement.dataset.nativeStructureChanges) + 1
      )
    })
    window.api.worktrees.onGitStatusMetadataChanged(() => {
      document.documentElement.dataset.nativeStatusChanges = String(
        Number(document.documentElement.dataset.nativeStatusChanges) + 1
      )
    })
  })
  const created = await runProcess({
    program: 'git',
    args: ['worktree', 'add', '-b', 'native-external', external],
    cwd: seededRepoPath
  })
  expect(created.code, created.stderr).toBe(0)
  await expect
    .poll(
      () => page.evaluate(() => Number(document.documentElement.dataset.nativeStructureChanges)),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0)
  await page.evaluate(() => {
    document.documentElement.dataset.nativeStatusChanges = '0'
  })
  const refreshed = await runProcess({
    program: 'git',
    args: [
      '-c',
      'user.name=Native Test',
      '-c',
      'user.email=native@test.local',
      'commit',
      '--allow-empty',
      '-m',
      'Native watcher metadata'
    ],
    cwd: seededRepoPath
  })
  expect(refreshed.code, refreshed.stderr).toBe(0)
  await expect
    .poll(() => page.evaluate(() => Number(document.documentElement.dataset.nativeStatusChanges)), {
      timeout: 30_000
    })
    .toBeGreaterThan(0)
})
