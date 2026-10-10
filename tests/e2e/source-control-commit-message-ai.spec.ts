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

  test('copies and saves a base preview without losing staged context', async ({
    orcaPage,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const { branchName, worktreePath } = createWorktreeWithStagedChange(testRepoPath)
    registerPostElectronShutdownCleanup(async () =>
      cleanupWorktree(testRepoPath, worktreePath, branchName)
    )
    const generatorPath = path.join(os.tmpdir(), `${branchName}-preview-generator.cjs`)
    writeLinkedIssueEchoGenerator(generatorPath, [
      "  const valid = prompt.includes('diff --git a/README.md b/README.md') && prompt.includes('+Generated flow.') && prompt.includes('Use Conventional Commits.') && !prompt.includes('src/example.ts') && !prompt.includes('{stagedPatch}')",
      "  process.stdout.write(valid ? 'fix: describe real staged changes' : 'wrong context')"
    ])
    try {
      await waitForSessionReady(orcaPage)
      await openSourceControlForWorktree(orcaPage, testRepoPath, worktreePath)
      await orcaPage.evaluate(async () => {
        await window.__store!.getState().updateSettings({
          activeRuntimeEnvironmentId: null,
          sourceControlAi: {
            enabled: true,
            agentId: null,
            customAgentCommand: '',
            selectedModelByAgent: {},
            selectedThinkingByModel: {},
            instructionsByOperation: {},
            actions: {}
          },
          commitMessageAi: {
            enabled: true,
            agentId: null,
            customAgentCommand: '',
            selectedModelByAgent: {},
            selectedThinkingByModel: {},
            customPrompt: ''
          }
        })
      })
      await orcaPage.getByRole('button', { name: 'Generate commit message with AI' }).click()
      const dialog = orcaPage.getByRole('dialog', { name: 'Generate Commit Message' })
      await expect(dialog).toBeVisible()
      await orcaPage.evaluate(async (generatorPath) => {
        await window.__store!.getState().updateSettings({
          sourceControlAi: {
            enabled: true,
            agentId: 'custom',
            selectedModelByAgent: {},
            selectedThinkingByModel: {},
            instructionsByOperation: {},
            actions: {},
            customAgentCommand: `node ${JSON.stringify(generatorPath)}`
          }
        })
      }, generatorPath)
      await dialog.getByRole('button', { name: '{basePrompt}', exact: true }).hover()
      const preview = orcaPage.locator('[data-slot="hover-card-content"] pre')
      await expect(preview).toContainText('{stagedPatch}')
      const copied = await preview.innerText()
      expect(copied).toContain('{stagedFiles}')
      expect(copied).not.toContain('src/example.ts')
      await orcaPage.screenshot({ path: testInfo.outputPath('preview-placeholders.png') })
      await orcaPage.locator('[data-slot="hover-card-content"]').evaluate((card) => {
        card.scrollTop = card.scrollHeight
      })
      await orcaPage.screenshot({ path: testInfo.outputPath('preview-context-placeholders.png') })
      await dialog.getByRole('heading', { name: 'Generate Commit Message' }).hover()
      await expect(preview).not.toBeVisible()
      const template = dialog.getByRole('textbox', { name: 'Command template' })
      await template.fill('Write a commit message without context.')
      await expect(dialog).toContainText('never sees the staged changes')
      await orcaPage.screenshot({ path: testInfo.outputPath('missing-context-warning.png') })
      await template.fill(
        copied.replace(
          '- First line: imperative mood, <= 72 chars, no trailing period.',
          '- Use Conventional Commits.'
        )
      )
      await expect(dialog).not.toContainText('never sees the staged changes')
      await dialog.getByRole('button', { name: 'Save defaults', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Save defaults', exact: true })).toHaveCount(
        0
      )
      await orcaPage.screenshot({ path: testInfo.outputPath('saved-template.png') })
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
      const message = orcaPage.getByRole('textbox', { name: 'Commit message', exact: true })
      await expect(message).toHaveValue('fix: describe real staged changes', { timeout: 20_000 })
      await message.fill('')
      await orcaPage.getByRole('button', { name: 'Generate commit message with AI' }).click()
      await expect(dialog).not.toBeVisible()
      await expect(message).toHaveValue('fix: describe real staged changes', { timeout: 20_000 })
      await orcaPage.screenshot({ path: testInfo.outputPath('generated-from-saved-template.png') })
    } finally {
      rmSync(generatorPath, { force: true })
    }
  })
})
