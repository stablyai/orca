import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeWorktreeCreateResult } from '../../src/shared/runtime-types'

// "Close Setup Tab When It Succeeds" must close a Setup tab even when its workspace was never shown.

function createSetupRepo(setup: string): string {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'orca-setup-autoclose-repo-'))
  writeFileSync(path.join(repoPath, 'orca.yaml'), `scripts:\n  setup: |\n${setup}`)
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync(
    'git',
    ['-c', 'user.name=Orca E2E', '-c', 'user.email=orca-e2e@example.com', 'commit', '-m', 'seed'],
    { cwd: repoPath }
  )
  return repoPath
}

function setupTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((worktreeId) => {
    const tabs = window.__store?.getState().tabsByWorktree[worktreeId] ?? []
    return tabs.filter((tab) => (tab.customTitle ?? tab.title) === 'Setup').map((tab) => tab.id)
  }, worktreeId)
}

async function createWorkspace(
  page: Page,
  client: RuntimeClient,
  setup: string,
  activate: boolean,
  cleanups: string[]
): Promise<string> {
  const repoPath = createSetupRepo(setup)
  cleanups.push(repoPath)
  const added = await client.call<{ repo: { id: string } }>('repo.add', {
    path: repoPath,
    kind: 'git'
  })
  await page.evaluate(() =>
    window.__store?.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
  )
  const created = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
    repo: `id:${added.result.repo.id}`,
    name: `setup-autoclose-${randomUUID().slice(0, 8)}`,
    noParent: true,
    activate,
    setupDecision: 'run'
  })
  cleanups.push(created.result.worktree.path)
  return created.result.worktree.id
}

async function visit(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(worktreeId)
  }, worktreeId)
  await ensureTerminalVisible(page)
}

test.describe('setup tab auto-close', () => {
  test.skip(process.platform === 'win32', 'POSIX setup scripts')

  test('closes a successful Setup tab and keeps a failed one', async ({
    electronApp,
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    // Why: three workspaces each run a real setup script, one of them sleeping 4s while the tab is checked.
    test.setTimeout(240_000)
    const cleanups: string[] = []
    registerPostElectronShutdownCleanup(async () => {
      for (const target of cleanups) {
        rmSync(target, { recursive: true, force: true })
      }
    })
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() =>
      window.__store?.getState().updateSettings({ closeSetupTabOnSuccess: true })
    )
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 30_000, null, null)

    // Background create: the workspace is never shown while setup runs.
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'orca-setup-marker-')), 'done')
    cleanups.push(path.dirname(marker))
    const background = await createWorkspace(
      orcaPage,
      client,
      `    echo SETUP_LINE_ONE\n    sleep 4\n    touch '${marker}'\n`,
      false,
      cleanups
    )
    await expect
      .poll(() => setupTabIds(orcaPage, background), {
        timeout: 30_000,
        message: 'background Setup tab never appeared in the window'
      })
      .toHaveLength(1)
    // The tab must still be there while setup is running, so the close below is the exit's doing.
    expect(existsSync(marker)).toBe(false)
    await expect
      .poll(() => setupTabIds(orcaPage, background), {
        timeout: 30_000,
        message: 'background Setup tab did not close before its workspace was visited'
      })
      .toHaveLength(0)
    expect(existsSync(marker)).toBe(true)
    expect(
      await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
    ).not.toBe(background)

    // Focused create: the workspace is shown while setup runs.
    const focused = await createWorkspace(orcaPage, client, '    echo SETUP_OK\n', true, cleanups)
    await expect.poll(() => setupTabIds(orcaPage, focused), { timeout: 30_000 }).toHaveLength(0)

    // Control: a failed setup keeps its tab, also after the workspace is visited.
    const failed = await createWorkspace(
      orcaPage,
      client,
      '    echo SETUP_FAILS\n    false\n    echo NEVER\n',
      false,
      cleanups
    )
    await expect.poll(() => setupTabIds(orcaPage, failed), { timeout: 30_000 }).toHaveLength(1)
    await visit(orcaPage, failed)
    // Give a wrongly-closing exit path time to act before asserting the tab survived.
    // ast-grep-ignore: test-no-real-time-wait -- proving a close never happens has no condition to wait on
    await orcaPage.waitForTimeout(5_000)
    expect(await setupTabIds(orcaPage, failed)).toHaveLength(1)
  })
})
