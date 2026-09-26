import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../../shared/claude/project-claude-account-preference'
import { parseWorkspaceSession } from '../../../../../shared/workspace-session-schema'
import { resolveProjectClaudeAccount } from '../../../../../main/claude-accounts/project-claude-account-resolution'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'

const PANE_KEY = 'tab1:pane-1'
const store = {
  // Why empty: after a restart this renderer never saw the original launch.
  agentStatusByPaneKey: {},
  agentLaunchConfigByPaneKey: {},
  getAgentLaunchConfigForStatusEntry: () => undefined,
  settings: { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} }
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/sleeping-record-execution-host-scope', () => ({
  agentResumeOriginNamesAnotherExecutionHost: () => false,
  sleepingRecordNamesAnotherExecutionHost: () => false
}))

/** The record as it comes back from disk after the app restarts. */
function persistedRecord(claudeAccountId: string): SleepingAgentSessionRecord {
  const parsed = parseWorkspaceSession({
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab1',
        worktreeId: 'repo-1::/repo',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' },
        prompt: '',
        state: 'done',
        capturedAt: 10,
        updatedAt: 10,
        origin: 'quit',
        launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId }
      }
    }
  })
  const record = parsed.ok ? parsed.value.sleepingAgentSessionsByPaneKey?.[PANE_KEY] : undefined
  if (!record) {
    throw new Error('sleeping record did not survive the workspace-session schema')
  }
  return record
}

function coldRestoreAccountId(record: SleepingAgentSessionRecord): string | undefined {
  const session = {
    cacheKey: PANE_KEY,
    pendingStartupCommand: null,
    getSleepingRecordForPane: () => ({ paneKey: PANE_KEY, record }),
    projectRuntime: undefined,
    connectionId: null,
    executionHostId: null,
    worktree: { path: '/repo' },
    shellOverride: undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cold-restore builder reads only the fields set above.
  const typedSession = session as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(typedSession)
  const startup = typedSession.buildColdRestoreAgentResumeStartup()
  expect(startup?.command).toContain('claude-session')
  // Main's spawn preflight resolves the pane's account from exactly this launch config.
  return resolveProjectClaudeAccount({
    getRepo: () => ({
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      agentAccounts: { claude: { mode: 'account', accountId: 'acct-project-default' } }
    }),
    worktreeId: 'repo-1::/repo',
    launchConfigAccountId: startup?.launchConfig.claudeAccountId
  })
}

describe('cold resume after the daemon died replays the recorded Claude account', () => {
  it('pins the resumed session to its original account, not the project default', () => {
    expect(coldRestoreAccountId(persistedRecord('acct-b'))).toBe('acct-b')
  })

  it('keeps an active-account launch unpinned', () => {
    expect(coldRestoreAccountId(persistedRecord(ACTIVE_CLAUDE_ACCOUNT))).toBeUndefined()
  })
})
