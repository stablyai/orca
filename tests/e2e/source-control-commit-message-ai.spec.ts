import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { writeLinkedIssueEchoGenerator } from './helpers/source-control-ai-generators'
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
  // Why: the unlinked case separates a real resolver from one that always returns a number,
  // and — because the generator echoes the whole line — a literal `{linkedIssue}` reaches the
  // assertion as `saw-issue:{linkedIssue}` instead of masquerading as the empty expansion.
  for (const { label, linkedIssue, expected } of [
    { label: 'substitutes the workspace-linked issue into', linkedIssue: 4242, expected: '4242' },
    {
      label: 'expands the issue token to nothing for an unlinked workspace in',
      linkedIssue: null,
      expected: 'empty'
    }
  ]) {
    test(`${label} the commit-message recipe`, async ({ orcaPage, testRepoPath }) => {
      const { branchName, worktreePath } = createWorktreeWithStagedChange(testRepoPath)
      const generatorPath = path.join(os.tmpdir(), `${branchName}-linked-issue-generator.cjs`)
      writeLinkedIssueEchoGenerator(generatorPath, ['  process.stdout.write(`saw-issue:${issue}`)'])

      try {
        await waitForSessionReady(orcaPage)
        await openSourceControlForWorktree(orcaPage, testRepoPath, worktreePath)

        await orcaPage.evaluate(
          async ({ generatorPath, linkedIssue }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            const worktreeId = store.getState().activeWorktreeId
            if (!worktreeId) {
              throw new Error('No worktree was active after opening Source Control')
            }
            await window.api.worktrees.updateMeta({ worktreeId, updates: { linkedIssue } })
            const customAgentCommand = `node ${JSON.stringify(generatorPath)}`
            await store.getState().updateSettings({
              activeRuntimeEnvironmentId: null,
              sourceControlAi: {
                enabled: true,
                agentId: 'custom' as const,
                selectedModelByAgent: {},
                selectedThinkingByModel: {},
                customAgentCommand,
                instructionsByOperation: {},
                actions: {
                  commitMessage: {
                    agentId: 'custom' as const,
                    commandInputTemplate: 'ORCA_E2E_ISSUE={linkedIssue}\n\n{basePrompt}'
                  }
                }
              }
            })
          },
          { generatorPath, linkedIssue }
        )

        const textarea = orcaPage.getByRole('textbox', { name: 'Commit message' })
        await expect(textarea).toBeVisible({ timeout: 10_000 })

        const generate = orcaPage.getByRole('button', { name: 'Generate commit message with AI' })
        await expect(generate).toBeEnabled()
        await generate.click()

        await expect(textarea).toHaveValue(`saw-issue:${expected}`, { timeout: 15_000 })
      } finally {
        rmSync(generatorPath, { force: true })
        cleanupWorktree(testRepoPath, worktreePath, branchName)
      }
    })
  }

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
