import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { openSourceControlForWorktree } from './helpers/worktree-registration'

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
      await openSourceControlForWorktree(orcaPage, testRepoPath, worktreePath, {
        commitMessageAi: {
          enabled: true,
          agentId: 'custom',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: agentCommand
        }
      })

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
