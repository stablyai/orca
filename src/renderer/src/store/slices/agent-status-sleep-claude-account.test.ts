import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import { resolveProjectClaudeAccount } from '../../../../main/claude-accounts/project-claude-account-resolution'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000
const PANE_KEY = 'tab-1:leaf-1'
const SESSION = { key: 'session_id' as const, id: 'claude-session' }

afterEach(() => {
  vi.useRealTimers()
})

function claudeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    providerSession: SESSION,
    ...overrides
  }
}

function priorRecord(claudeAccountId: string): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: SESSION,
    prompt: '',
    state: 'done',
    capturedAt: NOW - 1,
    updatedAt: NOW - 1,
    origin: 'live',
    launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId }
  }
}

/** A store after an app restart: no launch records, only persisted state and main's rows. */
function restartedStore(
  entry: AgentStatusEntry,
  records: Record<string, SleepingAgentSessionRecord> = {}
) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
    agentStatusByPaneKey: { [PANE_KEY]: entry },
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: records
  })
  return store
}

function resumedAccount(record: SleepingAgentSessionRecord | undefined): string | undefined {
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
    launchConfigAccountId: record?.launchConfig?.claudeAccountId
  })
}

describe('sleeping a workspace after a restart keeps the Claude account', () => {
  it('carries the persisted record’s account, including the active sentinel', () => {
    const pinned = restartedStore(claudeEntry(), { [PANE_KEY]: priorRecord('acct-b') })
    pinned.getState().captureSleepingAgentSessionsByWorktree('wt-1')
    expect(resumedAccount(pinned.getState().sleepingAgentSessionsByPaneKey[PANE_KEY])).toBe(
      'acct-b'
    )

    const active = restartedStore(claudeEntry(), { [PANE_KEY]: priorRecord(ACTIVE_CLAUDE_ACCOUNT) })
    active.getState().captureSleepingAgentSessionsByWorktree('wt-1')
    expect(
      resumedAccount(active.getState().sleepingAgentSessionsByPaneKey[PANE_KEY])
    ).toBeUndefined()
  })

  it("falls back to main's pinned account when no record carries the launch config", () => {
    const store = restartedStore(claudeEntry({ claudeAccountId: 'acct-b' }))
    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')
    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.launchConfig).toMatchObject({ claudeAccountId: 'acct-b' })
    expect(resumedAccount(record)).toBe('acct-b')
  })

  it("captures main's pinned account on quit for a working pane", () => {
    const store = restartedStore(claudeEntry({ state: 'working', claudeAccountId: 'acct-b' }))
    store.getState().captureAllSleepingAgentSessions('quit')
    expect(resumedAccount(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY])).toBe('acct-b')
  })
})
