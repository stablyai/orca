import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

function gitInWorktree(worktreePath: string, args: string[]): string {
  const result = runProcessSync({ program: 'git', args, cwd: worktreePath, timeoutMs: 10_000 })
  if (result.code !== 0) {
    throw new Error(`Git fixture failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

test('offers Resolve with AI for a paused rebase with no unmerged files', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'operation-recovery')
  const baseBranch = `${fixture.branchName}-base`
  registerPostElectronShutdownCleanup(async () => {
    runProcessSync({ program: 'git', args: ['rebase', '--abort'], cwd: fixture.worktreePath })
    cleanupGoldenWorktree(testRepoPath, fixture)
    runProcessSync({ program: 'git', args: ['branch', '-D', baseBranch], cwd: testRepoPath })
  })

  gitInWorktree(fixture.worktreePath, ['branch', baseBranch])
  const changedPath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)
  writeFileSync(changedPath, 'export const hello = "feature"\n')
  gitInWorktree(fixture.worktreePath, ['commit', '-am', 'Feature change'])
  gitInWorktree(fixture.worktreePath, ['checkout', baseBranch])
  writeFileSync(changedPath, 'export const hello = "base"\n')
  gitInWorktree(fixture.worktreePath, ['commit', '-am', 'Base change'])
  gitInWorktree(fixture.worktreePath, ['checkout', fixture.branchName])
  const rebase = runProcessSync({
    program: 'git',
    args: ['rebase', baseBranch],
    cwd: fixture.worktreePath,
    timeoutMs: 10_000
  })
  expect(rebase.code).not.toBe(0)
  expect(gitInWorktree(fixture.worktreePath, ['diff', '--name-only', '--diff-filter=U'])).toBe(
    GOLDEN_CHANGED_PATH
  )
  writeFileSync(changedPath, 'export const hello = "resolved"\n')
  gitInWorktree(fixture.worktreePath, ['add', GOLDEN_CHANGED_PATH])

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('explorer')
    state?.setRightSidebarOpen(true)
  })
  await orcaPage.getByRole('button', { name: /Source Control/ }).click()
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Missing store')
    }
    const state = store.getState()
    if (!state.settings) {
      throw new Error('Missing settings')
    }
    if (!state.settings.sourceControlAi) {
      throw new Error('Missing AI settings')
    }
    store.setState({
      settings: {
        ...state.settings,
        sourceControlAi: {
          ...state.settings.sourceControlAi,
          enabled: true,
          agentId: null,
          actions: {},
          launchActionDefaults: {}
        }
      },
      ensureDetectedAgents: async () => []
    })
    state.beginRemoteOperation('fetch')
  })

  const resolve = orcaPage.getByRole('button', { name: 'Resolve with AI', exact: true })
  await expect(orcaPage.getByText('Rebase in progress', { exact: true })).toBeVisible()
  await expect(resolve).toBeEnabled()
  await resolve.click()
  await expect(orcaPage.getByRole('dialog')).toContainText('Resolve Conflicts With AI')
  await expect(orcaPage.getByRole('dialog')).toHaveCSS('opacity', '1')
  await orcaPage.screenshot({ path: testInfo.outputPath('rebase-recovery.png') })
  await orcaPage.getByRole('button', { name: 'Cancel', exact: true }).click()

  await orcaPage.evaluate(() => {
    const store = window.__store
    const settings = store?.getState().settings
    if (store && settings?.sourceControlAi) {
      store.setState({
        settings: { ...settings, sourceControlAi: { ...settings.sourceControlAi, enabled: false } }
      })
    }
  })
  await expect(resolve).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'Abort rebase', exact: true })).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
