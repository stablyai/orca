import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const DAY_MS = 24 * 60 * 60 * 1000
const IDENTITY = ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid']

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env })
}

function ageTree(paths: readonly string[], days: number): void {
  const at = new Date(Date.now() - days * DAY_MS)
  for (const target of paths) {
    utimesSync(target, at, at)
  }
}

/** A repo whose worktrees each carry one of the new cleanup signals, plus a stray folder. */
function createSignalsFixture(nested: boolean): {
  root: string
  repoPath: string
  worktreeRoot: string
  strayPath: string
} {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-cleanup-signals-')))
  const repoPath = path.join(root, 'signals-repo')
  const worktreeRoot = path.join(root, 'worktrees')
  const checkoutParent = nested ? path.join(worktreeRoot, 'signals-repo') : worktreeRoot
  mkdirSync(checkoutParent, { recursive: true })
  git(root, ['init', '--quiet', '--bare', path.join(root, 'origin.git')])
  git(root, ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(path.join(repoPath, 'README.md'), 'signals\n')
  git(repoPath, ['add', 'README.md'])
  git(repoPath, [...IDENTITY, 'commit', '--quiet', '-m', 'initial'])
  git(repoPath, ['remote', 'add', 'origin', path.join(root, 'origin.git')])

  const merged = path.join(checkoutParent, 'feature-merged')
  git(repoPath, ['worktree', 'add', '--quiet', '-b', 'feature-merged', merged])
  writeFileSync(path.join(merged, 'merged.txt'), 'done\n')
  git(merged, ['add', 'merged.txt'])
  git(merged, [...IDENTITY, 'commit', '--quiet', '-m', 'finish feature'])
  git(repoPath, [...IDENTITY, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'feature-merged'])
  git(repoPath, ['push', '--quiet', 'origin', 'main'])

  const gone = path.join(checkoutParent, 'feature-gone')
  git(repoPath, ['worktree', 'add', '--quiet', '-b', 'feature-gone', gone])
  rmSync(gone, { recursive: true, force: true })

  // Why the committer date: the activity probe reads the reflog, which would otherwise say "now".
  const oldDate = new Date(Date.now() - 12 * DAY_MS).toISOString()
  const agent = path.join(repoPath, '.claude', 'worktrees', 'agent-e2e')
  git(repoPath, ['worktree', 'add', '--quiet', '-b', 'agent-e2e', agent], {
    ...process.env,
    GIT_COMMITTER_DATE: oldDate
  })
  const agentGitDir = path.join(repoPath, '.git', 'worktrees', 'agent-e2e')
  // Every file the activity probe stats; `worktree add` leaves ORIG_HEAD behind from its reset.
  ageTree(
    [
      agent,
      path.join(agent, '.git'),
      path.join(agentGitDir, 'HEAD'),
      path.join(agentGitDir, 'ORIG_HEAD')
    ],
    12
  )

  const strayPath = path.join(checkoutParent, 'leftover-checkout')
  mkdirSync(strayPath)
  writeFileSync(path.join(strayPath, 'notes.txt'), 'left behind\n')
  ageTree([strayPath], 10)
  return { root, repoPath, worktreeRoot, strayPath }
}

test.describe('Workspace cleanup signals', () => {
  test.use({ seedTestRepo: false })

  test('shows merged, stale agent, prunable and unregistered signals', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const nested = await orcaPage.evaluate(
      () => window.__store?.getState().settings?.nestWorkspaces === true
    )
    const fixture = createSignalsFixture(nested)
    try {
      await orcaPage.evaluate(
        async ({ repoPath, worktreeRoot }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }
          const repo = await store.getState().addRepoPath(repoPath)
          if (!repo) {
            throw new Error(`repo not added: ${repoPath}`)
          }
          await store.getState().updateRepo(repo.id, { worktreeBasePath: worktreeRoot })
          store.getState().openModal('workspace-cleanup')
        },
        { repoPath: fixture.repoPath, worktreeRoot: fixture.worktreeRoot }
      )

      const dialog = orcaPage.getByRole('dialog')
      const row = (name: string) =>
        dialog.locator('div.group', {
          has: orcaPage.locator('[data-workspace-cleanup-row-name]', { hasText: name })
        })
      await expect(row('feature-merged').getByText('Merged', { exact: true })).toBeVisible({
        timeout: 60_000
      })
      await expect(row('agent-e2e').getByText('Stale agent', { exact: true })).toBeVisible()
      await expect(row('feature-gone').getByText('Prunable', { exact: true })).toBeVisible()
      await expect(row('feature-merged').getByText('Stale agent')).toHaveCount(0)

      const strayFolders = dialog.locator('[data-workspace-cleanup-stray-folders]')
      await expect(strayFolders).toContainText('Unregistered folders: 1')
      await strayFolders.getByRole('button', { name: /Unregistered folders/ }).click()
      await expect(strayFolders.getByText(fixture.strayPath, { exact: true })).toBeVisible()
      await expect(strayFolders.getByText('Unregistered', { exact: true })).toBeVisible()
      await expect(strayFolders.getByRole('button', { name: 'Move to Trash' })).toBeEnabled()

      await orcaPage.screenshot({ path: testInfo.outputPath('cleanup-signals-dialog.png') })
      await dialog.screenshot({ path: testInfo.outputPath('cleanup-signals-dialog-only.png') })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
