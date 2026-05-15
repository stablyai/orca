import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

function createWorktreeWithStagedChange(repoPath: string): {
  branchName: string
  worktreePath: string
} {
  const branchName = `e2e-ai-commit-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const worktreePath = path.join(os.tmpdir(), branchName)
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  writeFileSync(
    path.join(worktreePath, 'README.md'),
    '# AI Commit Message E2E\n\nGenerated flow.\n'
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
    rmSync(worktreePath, { recursive: true, force: true })
  }
  try {
    execFileSync('git', ['branch', '-D', branchName], { cwd: repoPath, stdio: 'pipe' })
  } catch {
    // The branch is already gone when git prunes it with the worktree.
  }
}

test.describe('Source Control AI commit messages', () => {
  test('generates a commit message from staged changes through the Source Control UI', async ({
    orcaPage,
    testRepoPath
  }) => {
    const { branchName, worktreePath } = createWorktreeWithStagedChange(testRepoPath)
    const agentCommand =
      'node -e "setTimeout(() => process.stdout.write(\'Add generated E2E message\'), 250)"'

    try {
      await waitForSessionReady(orcaPage)
      await orcaPage.evaluate(
        async ({ repoPath, worktreePath: targetWorktreePath, agentCommand: command }) => {
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
          await store.getState().updateSettings({
            commitMessageAi: {
              enabled: true,
              agentId: 'custom',
              selectedModelByAgent: {},
              selectedThinkingByModel: {},
              customPrompt: '',
              customAgentCommand: command
            }
          })
          const status = await window.api.git.status({ worktreePath: worktree.path })
          store.getState().setGitStatus(worktree.id, status)
          store.getState().setRightSidebarTab('source-control')
          store.getState().setRightSidebarOpen(true)
        },
        { repoPath: testRepoPath, worktreePath, agentCommand }
      )

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              return Boolean(state?.rightSidebarOpen && state?.rightSidebarTab === 'source-control')
            }),
          { timeout: 5_000 }
        )
        .toBe(true)

      const textarea = orcaPage.getByRole('textbox', { name: 'Commit message' })
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await expect(textarea).toHaveValue('')

      const generate = orcaPage.getByRole('button', { name: 'Generate commit message with AI' })
      await expect(generate).toBeVisible()
      await expect(generate).toBeEnabled()
      await generate.click()

      await expect(
        orcaPage.getByRole('button', { name: 'Stop generating commit message' })
      ).toBeVisible()
      await expect(textarea).toHaveValue('Add generated E2E message', { timeout: 10_000 })
    } finally {
      cleanupWorktree(testRepoPath, worktreePath, branchName)
    }
  })
})
