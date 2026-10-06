// Ported from community PR #19704 (Minhoi Goo): a tab in native chat view must keep that fact in
// its sleep record, or a wake reopens it as a plain terminal (#19668). Extended so a record saves
// 'terminal' too, and chat only for the pane that owned the tab's chat.

import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'

function terminalTab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
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

function entry(leafId = LEAF): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: `${TAB_ID}:${leafId}`,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: []
  }
}

function state(unified: Tab, layout?: Record<string, unknown>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleepingRecordFromEntry reads only these three indices.
  return {
    tabsByWorktree: { [WORKTREE_ID]: [terminalTab()] },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [unified] },
    terminalLayoutsByTabId: layout ? { [TAB_ID]: layout } : {}
  } as unknown as AppState
}

const SPLIT_LAYOUT = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: LEAF },
    second: { type: 'leaf', leafId: SIBLING_LEAF }
  },
  activeLeafId: LEAF,
  expandedLeafId: null,
  chatLeafId: LEAF
}

function capture(appState: AppState, leafId?: string) {
  return sleepingRecordFromEntry({
    state: appState,
    entry: entry(leafId),
    worktreeId: WORKTREE_ID,
    capturedAt: 2
  })?.viewMode
}

describe('sleepingRecordFromEntry viewMode capture', () => {
  it('carries the source tab chat viewMode into the record', () => {
    expect(capture(state(unifiedTab({ viewMode: 'chat' })))).toBe('chat')
  })

  it('omits viewMode for a tab nobody switched', () => {
    expect(capture(state(unifiedTab()))).toBeUndefined()
  })

  it('saves terminal for a tab switched to terminal', () => {
    expect(capture(state(unifiedTab({ viewMode: 'terminal' })))).toBe('terminal')
  })

  it('saves chat for the pane that owns a split chat tab', () => {
    expect(capture(state(unifiedTab({ viewMode: 'chat' }), SPLIT_LAYOUT), LEAF)).toBe('chat')
  })

  it('saves terminal for a sibling pane, so a wake never clones chat onto it', () => {
    expect(capture(state(unifiedTab({ viewMode: 'chat' }), SPLIT_LAYOUT), SIBLING_LEAF)).toBe(
      'terminal'
    )
  })
})
