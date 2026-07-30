import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  createBranchCommit,
  openSourceControl,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'
import { writeLinkedIssueEchoGenerator } from './helpers/source-control-ai-generators'
import { waitForSessionReady } from './helpers/store'

// Why: the PR path reads the echoed issue from the generated title.
function writeLinkedIssuePrEchoGenerator(scriptPath: string, base: string): void {
  writeLinkedIssueEchoGenerator(scriptPath, [
    '  process.stdout.write(JSON.stringify({',
    `    base: ${JSON.stringify(base)},`,
    '    title: `saw-issue:${issue}`,',
    "    body: 'linked-issue e2e body',",
    '    draft: false',
    '  }))'
  ])
}

test.describe('Source Control AI pull request linkedIssue', () => {
  // Why: the unlinked case separates a real resolver from one that always returns a number,
  // and — because the generator echoes the whole line into the title — a literal
  // `{linkedIssue}` reaches the assertion as `saw-issue:{linkedIssue}` instead of
  // masquerading as the empty expansion.
  for (const { label, linkedIssue, expected } of [
    { label: 'substitutes the workspace-linked issue into', linkedIssue: 4242, expected: '4242' },
    {
      label: 'expands the issue token to nothing for an unlinked workspace in',
      linkedIssue: null,
      expected: 'empty'
    }
  ]) {
    test(`${label} the pull-request recipe`, async ({ orcaPage }) => {
      await waitForSessionReady(orcaPage)
      const { prWorktreeId, prWorktreePath, primaryBranch } = await seedCreatePrComposer(orcaPage)
      createBranchCommit(prWorktreePath)

      const generatorPath = path.join(
        os.tmpdir(),
        `e2e-pr-linked-issue-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`
      )
      writeLinkedIssuePrEchoGenerator(generatorPath, primaryBranch)

      try {
        await orcaPage.evaluate(
          async ({ generatorPath, linkedIssue, worktreeId }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
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
                  pullRequest: {
                    agentId: 'custom' as const,
                    commandInputTemplate: 'ORCA_E2E_ISSUE={linkedIssue}\n\n{basePrompt}'
                  }
                }
              }
            })
          },
          { generatorPath, linkedIssue, worktreeId: prWorktreeId }
        )

        await openSourceControl(orcaPage, prWorktreeId)

        const title = orcaPage.getByRole('textbox', { name: 'Pull request title' })
        await expect(title).toBeVisible({ timeout: 10_000 })

        const generate = orcaPage.getByRole('button', {
          name: 'Generate pull request details with AI'
        })
        await expect(generate).toBeEnabled()
        await generate.click()

        await expect(title).toHaveValue(`saw-issue:${expected}`, { timeout: 15_000 })
      } finally {
        rmSync(generatorPath, { force: true })
      }
    })
  }
})
