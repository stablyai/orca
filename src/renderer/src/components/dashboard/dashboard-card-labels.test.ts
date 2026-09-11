import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { rowConversationName } from './dashboard-card-labels'
import type { DashboardAgentRow } from './useDashboardData'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-1'
const TAB: TerminalTab = {
  id: TAB_ID,
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: '\u2733 Linear work log',
  customTitle: null,
  aiVaultTitle: { agent: 'claude', sessionId: 'session-a', title: 'Provider title' },
  color: null,
  sortOrder: 0,
  createdAt: 0
}
const LAYOUT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_A },
    second: { type: 'leaf', leafId: LEAF_B }
  },
  activeLeafId: LEAF_A,
  expandedLeafId: null
}

function row(leafId: string, sessionId: string): DashboardAgentRow {
  const paneKey = makePaneKey(TAB_ID, leafId)
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    agentType: 'claude',
    paneKey,
    providerSession: { key: 'session_id', id: sessionId }
  }
  return { paneKey, entry, tab: TAB, agentType: 'claude', state: 'working', startedAt: 0 }
}

describe('rowConversationName', () => {
  it('publishes a provider title only for the split-pane session that owns it', () => {
    const paneTitles = { 1: '\u2733 Linear work log', 2: '\u2733 Redis cache strategy' }

    expect(rowConversationName(row(LEAF_A, 'session-a'), false, LAYOUT, paneTitles)).toBe(
      'Provider title'
    )
    expect(rowConversationName(row(LEAF_B, 'session-b'), false, LAYOUT, paneTitles)).toBe(
      'Redis cache strategy'
    )
  })
})
