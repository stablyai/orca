// A tab showing the native chat view (viewMode: 'chat') must keep that fact in
// its hibernation resume record, or Agent Sleep's restart re-opens it as a
// plain terminal — including for mobile clients, which only render the chat
// overlay when the tab's viewMode says so (#19668).

import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: TAB_ID,
    entityId: TAB_ID,
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: 'Agent',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? `${TAB_ID}:${LEAF}`
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

function stateWithTabs(termTab: TerminalTab, unified: Tab): AppState {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [termTab] },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [unified] }
  } as unknown as AppState
}

describe('sleepingRecordFromEntry viewMode capture', () => {
  it('carries the source tab chat viewMode into the record', () => {
    const state = stateWithTabs(terminalTab(), unifiedTab({ viewMode: 'chat' }))
    const record = sleepingRecordFromEntry({
      state,
      entry: entry(),
      worktreeId: WORKTREE_ID,
      capturedAt: 2
    })

    expect(record?.viewMode).toBe('chat')
  })

  it('omits viewMode for a plain terminal tab', () => {
    const state = stateWithTabs(terminalTab(), unifiedTab())
    const record = sleepingRecordFromEntry({
      state,
      entry: entry(),
      worktreeId: WORKTREE_ID,
      capturedAt: 2
    })

    expect(record?.viewMode).toBeUndefined()
  })
})
