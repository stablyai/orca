import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, ensureTerminalVisible } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

type NativeChatFixture = {
  paneKey: string
  worktreeId: string
  transcriptPath: string
}

test.use({ seedTestRepo: false })

const LONG_USER_MESSAGE = Array.from(
  { length: 10 },
  (_, index) => `Long native chat user line ${index + 1} for collapse coverage.`
).join('\n')

function createNativeChatRepo(): string {
  const repoPath = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'orca-native-chat-repo-'))
  )
  execSync('git init', { cwd: repoPath, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: repoPath, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), '# Native chat E2E\n')
  writeFileSync(path.join(repoPath, 'CLAUDE.md'), '# CLAUDE.md\n\nNative chat E2E instructions.\n')
  mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  writeFileSync(path.join(repoPath, 'src', 'index.ts'), 'export const nativeChat = true\n')
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' })
  execSync('git commit -m "Initial native chat E2E repo"', { cwd: repoPath, stdio: 'pipe' })
  return repoPath
}

function removeTempDirectory(directoryPath: string): void {
  try {
    rmSync(directoryPath, { recursive: true, force: true })
  } catch {
    // Why: Electron can briefly retain Windows handles to the activated repo.
  }
}

function writeClaudeTranscript(): { root: string; transcriptPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-native-chat-e2e-'))
  const transcriptPath = path.join(root, 'transcript.jsonl')
  const records = [
    {
      type: 'user',
      uuid: 'native-chat-e2e-user-long',
      timestamp: '2026-06-01T10:00:00.000Z',
      message: { role: 'user', content: LONG_USER_MESSAGE }
    },
    {
      type: 'assistant',
      uuid: 'native-chat-e2e-assistant-reply',
      timestamp: '2026-06-01T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Native chat E2E assistant reply.' }]
      }
    },
    {
      type: 'assistant',
      uuid: 'native-chat-e2e-tool-call',
      timestamp: '2026-06-01T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }]
      }
    },
    {
      type: 'user',
      uuid: 'native-chat-e2e-tool-result',
      timestamp: '2026-06-01T10:00:03.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'exit code 1\nnative chat failure branch',
            is_error: true
          }
        ]
      }
    }
  ]
  writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return { root, transcriptPath }
}

async function addRepoAndActivateWorktree(page: Page, repoPath: string): Promise<void> {
  await page.evaluate(async (repoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

    await window.api.repos.add({ path: repoPath })
    await store.getState().fetchRepos()
    const repo = store.getState().repos.find((candidate) => {
      const candidatePath = normalize(candidate.path)
      const expectedPath = normalize(repoPath)
      return candidatePath === expectedPath || candidatePath.startsWith(`${expectedPath}/`)
    })
    if (!repo) {
      throw new Error(`Expected native chat E2E repo to load: ${repoPath}`)
    }
    await store.getState().fetchWorktrees(repo.id)
    const nextState = store.getState()
    const worktree =
      (nextState.worktreesByRepo[repo.id] ?? []).find(
        (candidate) => normalize(candidate.path) === normalize(repoPath)
      ) ?? nextState.worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error(`Expected native chat E2E worktree to load: ${repoPath}`)
    }
    nextState.setActiveWorktree(worktree.id)
  }, repoPath)

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = window.__store
          const activeWorktreeId = store?.getState().activeWorktreeId ?? null
          return activeWorktreeId
        }),
      { timeout: 30_000, message: 'native chat E2E worktree did not become active' }
    )
    .not.toBeNull()
}

async function openSeededNativeChat(
  page: Page,
  transcriptPath: string
): Promise<NativeChatFixture> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  await waitForActivePanePtyId(page, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(page, 30_000)

  await page.evaluate(
    async ({ paneKey, worktreeId, transcriptPath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      store.setState({ settings })
      const state = store.getState()
      const terminalTabId = paneKey.split(':')[0]
      const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === terminalTabId
      )
      if (!unifiedTab) {
        throw new Error('No unified terminal tab found for native chat E2E')
      }
      state.setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'Review native chat workspace', agentType: 'claude' },
        'Claude',
        undefined,
        { tabId: terminalTabId, worktreeId },
        {
          providerSession: {
            key: 'session_id',
            id: 'native-chat-e2e-session',
            transcriptPath
          }
        }
      )
      state.setTabViewMode(unifiedTab.id, 'chat')
    },
    { ...descriptor, transcriptPath }
  )

  await expect(page.locator('[data-native-chat-root="true"]')).toBeVisible({ timeout: 15_000 })
  return { paneKey: descriptor.paneKey, worktreeId: descriptor.worktreeId, transcriptPath }
}

async function seedApprovalPrompt(page: Page, fixture: NativeChatFixture): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, transcriptPath }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const terminalTabId = paneKey.split(':')[0]
    store.getState().setAgentStatus(
      paneKey,
      {
        state: 'working',
        prompt: 'Approve a guarded command',
        agentType: 'claude',
        toolName: 'PermissionRequest',
        interactivePrompt: JSON.stringify({
          approval: { tool: 'Bash', summary: 'pnpm test -- --runInBand' }
        })
      },
      'Claude',
      undefined,
      { tabId: terminalTabId, worktreeId },
      {
        providerSession: {
          key: 'session_id',
          id: 'native-chat-e2e-session',
          transcriptPath
        }
      }
    )
  }, fixture)
}

test('native chat renders transcript, command, and pending approval states', async ({
  orcaPage
}, testInfo) => {
  const repoPath = createNativeChatRepo()
  const { root, transcriptPath } = writeClaudeTranscript()
  try {
    await addRepoAndActivateWorktree(orcaPage, repoPath)
    const fixture = await openSeededNativeChat(orcaPage, transcriptPath)
    const chat = orcaPage.locator('[data-native-chat-root="true"]')

    await expect(chat.getByText('Native chat E2E assistant reply.')).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Show full message' })).toBeVisible()
    await chat.getByRole('button', { name: 'Show full message' }).click()
    await expect(chat.getByRole('button', { name: 'Show less' })).toBeVisible()
    await expect(chat.getByText('Failed')).toBeVisible()

    const composer = chat.locator('textarea')
    await composer.fill('/definitely-not-a-command')
    await expect(chat.getByText('No matching commands')).toBeVisible()
    await composer.fill('@src')
    await expect(chat.getByText('Reference a file or path')).toBeVisible()

    await seedApprovalPrompt(orcaPage, fixture)
    await expect(chat.getByText('Pending approval')).toBeVisible()
    await expect(chat.getByText('Allow Bash?')).toBeVisible()
    await expect(chat.getByPlaceholder('Resolve the approval above to continue.')).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Allow' })).toBeEnabled()
    await expect(chat.getByRole('button', { name: 'Deny' })).toBeEnabled()

    await testInfo.attach('native-chat-workspace-ui', {
      body: await chat.screenshot(),
      contentType: 'image/png'
    })
  } finally {
    removeTempDirectory(root)
    removeTempDirectory(repoPath)
  }
})
