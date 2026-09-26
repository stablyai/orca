import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  normalizeAgentStatusEvent,
  normalizeAgentStatusMetadata,
  normalizeMainClaudeAccountId
} from '../../hooks/ipc-events/normalize-agent-status-event'
import { claudeTabAccountLabel } from '@/lib/claude-tab-account-label'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

function hostRow(receivedAt: number, claudeAccountId?: string): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    state: 'done',
    prompt: '',
    agentType: 'claude',
    receivedAt,
    stateStartedAt: receivedAt,
    ...(claudeAccountId ? { claudeAccountId } : {})
  }
}

function ingest(store: ReturnType<typeof createTestStore>, row: AgentStatusIpcPayload): void {
  const payload = normalizeAgentStatusEvent(row)
  if (!payload) {
    throw new Error('status row did not normalize')
  }
  store.getState().setAgentStatus(
    row.paneKey,
    { ...payload, claudeAccountId: normalizeMainClaudeAccountId(row) },
    undefined,
    { updatedAt: row.receivedAt, stateStartedAt: row.stateStartedAt },
    {
      tabId: row.tabId,
      worktreeId: row.worktreeId,
      connectionId: row.connectionId
    },
    normalizeAgentStatusMetadata(row)
  )
}

function restartedStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  })
  return store
}

describe("main's pinned Claude account on the agent-status row", () => {
  it('labels a restored tab from the startup snapshot with no renderer launch record', () => {
    const store = restartedStore()
    ingest(store, hostRow(1_000, 'acct-b'))

    const state = store.getState()
    expect(state.agentLaunchConfigByPaneKey[PANE_KEY]).toBeUndefined()
    expect(
      claudeTabAccountLabel(
        {
          statusAccountId: state.agentStatusByPaneKey[PANE_KEY]?.claudeAccountId,
          launchConfig: state.agentLaunchConfigByPaneKey[PANE_KEY]?.launchConfig
        },
        [
          {
            id: 'acct-b',
            email: 'b@example.com',
            authMethod: 'subscription-oauth',
            createdAt: 0,
            updatedAt: 0,
            lastAuthenticatedAt: 0
          }
        ],
        { isSshRepo: false }
      )
    ).toBe('b@example.com')
  })

  it('keeps the account across renderer-local writes and drops it when main reports unpinned', () => {
    const store = restartedStore()
    ingest(store, hostRow(1_000, 'acct-b'))
    store.getState().setAgentStatus(PANE_KEY, {
      state: 'working',
      prompt: 'x',
      agentType: 'claude'
    })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.claudeAccountId).toBe('acct-b')

    ingest(store, hostRow(Date.now() + 1_000))
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.claudeAccountId).toBeUndefined()
  })
})
