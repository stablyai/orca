import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type E2eWorktree = {
  branchName: string
  worktreePath: string
}

function createWorktreeWithStagedChange(repoPath: string): E2eWorktree {
  const branchName = `e2e-commit-draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const worktreePath = path.join(os.tmpdir(), branchName)
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  writeFileSync(
    path.join(worktreePath, 'README.md'),
    '# Commit Draft Persistence E2E\n\nPreserve this draft across remounts.\n'
  )
  execFileSync('git', ['add', 'README.md'], { cwd: worktreePath, stdio: 'pipe' })
  return { branchName, worktreePath }
}

function cleanupWorktree(repoPath: string, worktreePath: string, branchName: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    try {
      rmSync(worktreePath, { recursive: true, force: true })
      execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'pipe' })
    } catch {
      // Best effort: the branch delete below is still worth attempting.
    }
  }
  try {
    execFileSync('git', ['branch', '-D', branchName], { cwd: repoPath, stdio: 'pipe' })
  } catch {
    // The branch may already be gone when git prunes it with the worktree.
  }
}

async function openSourceControlForWorktree(
  page: Parameters<typeof waitForSessionReady>[0],
  repoPath: string,
  targetWorktreePath: string
): Promise<void> {
  await page.evaluate(
    async ({ repoPath, targetWorktreePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      await state.fetchRepos()
      const repo = store.getState().repos.find((entry) => entry.path === repoPath)
      if (!repo) {
        throw new Error(`Seeded E2E repo was not registered: ${repoPath}`)
      }

      const listedWorktrees = await window.api.worktrees.list({ repoId: repo.id })
      store.setState((current) => ({
        worktreesByRepo: {
          ...current.worktreesByRepo,
          [repo.id]: listedWorktrees
        }
      }))

      const normalizeMacTmpPath = (value: string): string =>
        value.startsWith('/private/var/') ? value.slice('/private'.length) : value
      const worktree = listedWorktrees.find(
        (entry) => normalizeMacTmpPath(entry.path) === normalizeMacTmpPath(targetWorktreePath)
      )
      if (!worktree) {
        throw new Error(
          `E2E worktree was not loaded: ${targetWorktreePath}; listed=${listedWorktrees
            .map((entry) => entry.path)
            .join(', ')}`
        )
      }

      store.getState().setActiveWorktree(worktree.id)
      const status = await window.api.git.status({ worktreePath: worktree.path })
      store.getState().setGitStatus(worktree.id, status)
      store.getState().setRightSidebarOpen(true)
      store.getState().setRightSidebarTab('source-control')
    },
    { repoPath, targetWorktreePath }
  )

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return Boolean(state?.rightSidebarOpen && state?.rightSidebarTab === 'source-control')
        }),
      { timeout: 5_000 }
    )
    .toBe(true)
}

test.describe('Source Control commit draft persistence', () => {
  test('preserves a typed draft when the sidebar tab remounts', async ({
    orcaPage,
    testRepoPath
  }) => {
    let firstWorktree: E2eWorktree | null = null
    let secondWorktree: E2eWorktree | null = null

    try {
      firstWorktree = createWorktreeWithStagedChange(testRepoPath)
      secondWorktree = createWorktreeWithStagedChange(testRepoPath)
      await waitForSessionReady(orcaPage)
      await openSourceControlForWorktree(orcaPage, testRepoPath, firstWorktree.worktreePath)

      const textarea = orcaPage.getByRole('textbox', { name: 'Commit message' })
      await expect(textarea).toBeVisible({ timeout: 10_000 })

      const draft = 'fix: keep draft after leaving Source Control'
      await textarea.fill(draft)
      await expect(textarea).toHaveValue(draft)

      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        state?.setRightSidebarTab('explorer')
      })
      await expect
        .poll(
          async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab ?? null),
          { timeout: 5_000 }
        )
        .toBe('explorer')
      await expect(textarea).toBeHidden()

      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        state?.setRightSidebarTab('source-control')
      })
      await expect
        .poll(
          async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab ?? null),
          { timeout: 5_000 }
        )
        .toBe('source-control')

      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await expect(textarea).toHaveValue(draft)

      await openSourceControlForWorktree(orcaPage, testRepoPath, secondWorktree.worktreePath)
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await expect(textarea).toHaveValue('')

      await openSourceControlForWorktree(orcaPage, testRepoPath, firstWorktree.worktreePath)
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await expect(textarea).toHaveValue(draft)
    } finally {
      for (const worktree of [firstWorktree, secondWorktree]) {
        if (worktree) {
          cleanupWorktree(testRepoPath, worktree.worktreePath, worktree.branchName)
        }
      }
    }
  })
})
