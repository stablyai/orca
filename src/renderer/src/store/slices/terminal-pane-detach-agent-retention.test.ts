import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { collectRetainedAgentsOnDisappear } from '@/components/dashboard/useRetainedAgents'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

// Detaching a completed split pane migrates the paneKey `sourceTab:leaf → targetTab:leaf`;
// these tests pin the store→hook contract that stops the sidebar resurrecting a ghost row.

const WORKTREE_ID = 'repo::/repo/worktree'
const SOURCE_TAB = 'tab-source'
const TARGET_TAB = 'tab-target'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const SOURCE_PANE_KEY = makePaneKey(SOURCE_TAB, LEAF)
const TARGET_PANE_KEY = makePaneKey(TARGET_TAB, LEAF)

function makeDoneEntry(paneKey: string, tabId: string): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Fix it',
    updatedAt: 100,
    stateStartedAt: 100,
    paneKey,
    tabId,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: false
  }
}

function makeRow(paneKey: string, tabId: string): DashboardAgentRow {
  return {
    paneKey,
    entry: makeDoneEntry(paneKey, tabId),
    tab: makeTab({ id: tabId, worktreeId: WORKTREE_ID }),
    agentType: 'claude',
    state: 'done',
    startedAt: 100
  }
}

function detachDoneAgentAndReadStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', path: '/repo/worktree' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: SOURCE_TAB, worktreeId: WORKTREE_ID, ptyId: 'pty-a' }),
        makeTab({ id: TARGET_TAB, worktreeId: WORKTREE_ID, ptyId: null })
      ]
    },
    ptyIdsByTabId: { [SOURCE_TAB]: ['pty-a', 'pty-sibling'], [TARGET_TAB]: [] }
  })
  store.getState().setAgentStatus(SOURCE_PANE_KEY, {
    state: 'done',
    prompt: 'Fix it',
    agentType: 'claude'
  })
  store.getState().syncPaneDetachPtyOwnership({
    detachedLeafId: LEAF,
    detachedPtyId: 'pty-a',
    sourceLayout: {
      root: { type: 'leaf', leafId: SIBLING_LEAF },
      activeLeafId: SIBLING_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SIBLING_LEAF]: 'pty-sibling' }
    },
    sourceTabId: SOURCE_TAB,
    targetTabId: TARGET_TAB
  })
  return store.getState()
}

describe('detach completed split pane → sidebar retention', () => {
  it('plants a source-key suppressor so the retention hook drops the migrated pane', () => {
    const state = detachDoneAgentAndReadStore()

    // Status migrated to the new tab's pane key.
    expect(state.agentStatusByPaneKey[SOURCE_PANE_KEY]).toBeUndefined()
    expect(state.agentStatusByPaneKey[TARGET_PANE_KEY]?.state).toBe('done')

    // The retention hook sees the old key vanish (prevRef held source, current
    // holds target). Feed it the REAL post-detach suppressor state.
    const result = collectRetainedAgentsOnDisappear({
      previousAgents: new Map([
        [SOURCE_PANE_KEY, { row: makeRow(SOURCE_PANE_KEY, SOURCE_TAB), worktreeId: WORKTREE_ID }]
      ]),
      currentAgents: new Map([
        [TARGET_PANE_KEY, { row: makeRow(TARGET_PANE_KEY, TARGET_TAB), worktreeId: WORKTREE_ID }]
      ]),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys,
      recentlyClosedAgentStatusTabIds: {}
    })

    // No ghost row; the one-shot suppressor is consumed instead of retained.
    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual([SOURCE_PANE_KEY])
  })

  it('does not plant a suppressor when the detached pane never had a live agent', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', path: '/repo/worktree' })]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab({ id: SOURCE_TAB, worktreeId: WORKTREE_ID, ptyId: 'pty-a' }),
          makeTab({ id: TARGET_TAB, worktreeId: WORKTREE_ID, ptyId: null })
        ]
      },
      ptyIdsByTabId: { [SOURCE_TAB]: ['pty-a', 'pty-sibling'], [TARGET_TAB]: [] }
    })

    // No setAgentStatus here: a plain terminal pane with no agent.
    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: LEAF,
      detachedPtyId: 'pty-a',
      sourceLayout: {
        root: { type: 'leaf', leafId: SIBLING_LEAF },
        activeLeafId: SIBLING_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SIBLING_LEAF]: 'pty-sibling' }
      },
      sourceTabId: SOURCE_TAB,
      targetTabId: TARGET_TAB
    })

    // Why: a suppressor is only consumed on a live→gone transition. The source
    // key was never live, so planting one here would leak it forever.
    expect(store.getState().retentionSuppressedPaneKeys[SOURCE_PANE_KEY]).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys[TARGET_PANE_KEY]).toBeUndefined()
  })
})
