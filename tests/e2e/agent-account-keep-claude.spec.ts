import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { emitClaudeHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const probeDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'claude-account-probe')
const SESSION_ID = 'e2e-kept-claude-session'

// Why a `claude` on PATH: Orca's shell function only wraps a real executable, and the probe
// prints which account folder and pointer file a launch reads instead of starting anything.
test.use({
  launchEnv: { PATH: [probeDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter) }
})

type SeededClaudeAccount = {
  id: string
  email: string
  managedAuthPath: string
  authMethod: 'subscription-oauth'
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

/** An account folder that already finished setup and holds a (fake) login of its own. */
function seedClaudeAccount(userData: string, id: string, email: string): SeededClaudeAccount {
  const accountDir = path.join(userData, 'claude-profiles', id)
  mkdirSync(path.join(accountDir, 'home'), { recursive: true })
  writeFileSync(
    path.join(accountDir, 'profile.json'),
    `${JSON.stringify({ version: 1, accountId: id, runtime: 'host' })}\n`
  )
  writeFileSync(
    path.join(accountDir, 'home', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  )
  return {
    id,
    email,
    managedAuthPath: path.join(userData, 'claude-accounts', id),
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

async function selectClaudeAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate(async (accountId) => {
    await window.__store!.getState().updateSettings({
      activeClaudeManagedAccountId: accountId,
      activeClaudeManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
    })
  }, accountId)
}

async function openTerminalTab(page: Page): Promise<{ tabId: string; ptyId: string }> {
  const tabId = await page.evaluate(() => {
    const state = window.__store!.getState()
    const tab = state.createTab(state.activeWorktreeId!)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', state.activeWorktreeId ?? null)
    return tab.id
  })
  await waitForActiveTerminalManager(page)
  return { tabId, ptyId: await waitForActivePanePtyId(page) }
}

test.describe('Keeping a Claude agent on its account', () => {
  test.skip(process.platform === 'win32', 'The probe standing in for claude is a POSIX script')

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('a kept conversation resumes on its account while another is selected', async ({
    electronApp,
    orcaPage
  }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const work = seedClaudeAccount(userData, 'e2e-keep-work', 'work@example.com')
    const personal = seedClaudeAccount(userData, 'e2e-keep-personal', 'personal@example.com')
    await orcaPage.evaluate(
      async ({ work, personal }) => {
        await window.__store!.getState().updateSettings({
          claudeManagedAccounts: [work, personal]
        })
      },
      { work, personal }
    )
    await selectClaudeAccount(orcaPage, work.id)

    // The agent starts on the selected account and reports its session.
    const agentPane = await openTerminalTab(orcaPage)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    await execInTerminal(orcaPage, agentPane.ptyId, 'claude')
    await waitForTerminalOutput(orcaPage, `CLAUDE_ACCOUNT_PROBE ${work.id} selected-host`)
    await emitClaudeHookStatus(await readHookEndpoint(electronApp), {
      ...descriptor,
      prompt: 'Keep this on work',
      sessionId: SESSION_ID
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (paneKey) => window.__store!.getState().agentStatusByPaneKey[paneKey]?.runAccount ?? null,
          descriptor.paneKey
        )
      )
      .toMatchObject({ provider: 'claude', accountId: work.id, mode: 'follow' })

    const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${agentPane.tabId}"]`)
    await tab.click({ button: 'right' })
    await orcaPage.getByRole('menuitemcheckbox', { name: 'Keep on work@example.com' }).click()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (paneKey) => window.__store!.getState().agentStatusByPaneKey[paneKey]?.runAccount ?? null,
          descriptor.paneKey
        )
      )
      .toMatchObject({ accountId: work.id, mode: 'kept' })

    await selectClaudeAccount(orcaPage, personal.id)

    // Resuming the kept conversation starts it on its account, reading that account's own pointer.
    await orcaPage.evaluate((sessionId) => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      const resumeTab = state.createTab(worktreeId, undefined, undefined, {
        launchAgent: 'claude',
        pendingStartup: {
          command: `claude --resume ${sessionId}`,
          launchAgent: 'claude',
          resumeProviderSession: { key: 'session_id', id: sessionId }
        }
      })
      state.setActiveTab(resumeTab.id)
      state.setActiveTabType('terminal', worktreeId)
    }, SESSION_ID)
    // Why longer: like a selected-account start, a kept start first waits (capped) on its folder's refresh.
    await waitForTerminalOutput(
      orcaPage,
      `CLAUDE_ACCOUNT_PROBE ${work.id} account-${work.id}`,
      30_000
    )

    // Every other terminal still follows the selection.
    const plainPane = await openTerminalTab(orcaPage)
    await execInTerminal(orcaPage, plainPane.ptyId, 'claude')
    await waitForTerminalOutput(orcaPage, `CLAUDE_ACCOUNT_PROBE ${personal.id} selected-host`)
  })
})
