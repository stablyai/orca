import { describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import {
  hasFocusedAgentStatusForWorktree,
  type FocusedAgentStatusHighlightState
} from './focused-agent-status-highlight'

vi.mock('@/lib/agent-status', () => ({
  isExplicitAgentStatusFresh: vi.fn(
    (entry: AgentStatusEntry, now: number, staleAfterMs: number) =>
      now - entry.updatedAt <= staleAfterMs
  )
}))

const WORKTREE_ID = 'repo-1::/worktree'
const OTHER_WORKTREE_ID = 'repo-1::/other'
const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const OTHER_PANE_KEY = makePaneKey(TAB_ID, OTHER_LEAF_ID)

function makeTab(id: string, worktreeId = WORKTREE_ID): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentStatusEntry(paneKey: string, updatedAt = 1_000): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: []
  }
}

function makeUnsupportedEntry(paneKey: string): MigrationUnsupportedPtyEntry {
  return {
    ptyId: 'pty-unsupported',
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    paneKey,
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1_000
  }
}

function makeState(
  overrides: Partial<FocusedAgentStatusHighlightState> = {}
): FocusedAgentStatusHighlightState {
  return {
    activeWorktreeId: WORKTREE_ID,
    activeTabType: 'terminal',
    activeTabId: TAB_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab(TAB_ID)],
      [OTHER_WORKTREE_ID]: [makeTab(OTHER_TAB_ID, OTHER_WORKTREE_ID)]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    ...overrides
  }
}

describe('hasFocusedAgentStatusForWorktree', () => {
  it('highlights when the focused terminal pane has a fresh live agent status', () => {
    const state = makeState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry(PANE_KEY)
      }
    })

    expect(hasFocusedAgentStatusForWorktree(state, WORKTREE_ID, 2_000)).toBe(true)
  })

  it('does not highlight for another split pane in the same terminal tab', () => {
    const state = makeState({
      agentStatusByPaneKey: {
        [OTHER_PANE_KEY]: makeAgentStatusEntry(OTHER_PANE_KEY)
      }
    })

    expect(hasFocusedAgentStatusForWorktree(state, WORKTREE_ID, 2_000)).toBe(false)
  })

  it('does not highlight while another surface type is active', () => {
    const state = makeState({
      activeTabType: 'editor',
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry(PANE_KEY)
      }
    })

    expect(hasFocusedAgentStatusForWorktree(state, WORKTREE_ID, 2_000)).toBe(false)
  })

  it('highlights retained agent rows for the focused pane', () => {
    const entry = makeAgentStatusEntry(PANE_KEY)
    const state = makeState({
      retainedAgentsByPaneKey: {
        [PANE_KEY]: {
          entry,
          tab: makeTab(TAB_ID),
          worktreeId: WORKTREE_ID,
          agentType: 'codex',
          startedAt: 1_000
        }
      }
    })

    expect(hasFocusedAgentStatusForWorktree(state, WORKTREE_ID, 2_000)).toBe(true)
  })

  it('highlights migration-unsupported agent rows for the focused pane', () => {
    const state = makeState({
      migrationUnsupportedByPtyId: {
        'pty-unsupported': makeUnsupportedEntry(PANE_KEY)
      }
    })

    expect(hasFocusedAgentStatusForWorktree(state, WORKTREE_ID, 2_000)).toBe(true)
  })
})
