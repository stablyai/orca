import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildAttentionWorkspaceIds, type AttentionWorkspaceState } from './attention-workspaces'

const BASE = 1_700_000_000_000
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

const TAB: TerminalTab = {
  id: 'tab1',
  ptyId: 'pty-b',
  worktreeId: 'w1',
  title: 'shell',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: BASE
}

function workingHook(leafId: string): AgentStatusEntry {
  const paneKey = makePaneKey('tab1', leafId)
  return {
    paneKey,
    tabId: 'tab1',
    worktreeId: 'w1',
    state: 'working',
    prompt: 'do the thing',
    updatedAt: BASE,
    stateStartedAt: BASE - 5_000,
    stateHistory: [],
    agentType: 'claude'
  }
}

function stateAfterClosingFirstPane(layout: TerminalLayoutSnapshot): AttentionWorkspaceState {
  return {
    agentStatusByPaneKey: { [makePaneKey('tab1', LEAF_3)]: workingHook(LEAF_3) },
    migrationUnsupportedByPtyId: {},
    folderWorkspaces: [],
    tabsByWorktree: { w1: [TAB] },
    ptyIdsByTabId: { tab1: ['pty-b', 'pty-c'] },
    runtimePaneTitlesByTabId: { tab1: { 2: '❓ Claude needs your permission', 3: '⠋ Claude' } },
    terminalLayoutsByTabId: { tab1: layout },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {}
  }
}

describe('buildAttentionWorkspaceIds after an in-session pane close', () => {
  it('keeps a waiting survivor whose sibling has a fresh working hook', () => {
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-b', [LEAF_3]: 'pty-c' }
    }

    expect([...buildAttentionWorkspaceIds(stateAfterClosingFirstPane(layout), BASE)]).toEqual([
      'w1'
    ])
  })

  it('keeps a prompt when only the waiting pane has painted a title yet', () => {
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null
    }
    const state: AttentionWorkspaceState = {
      ...stateAfterClosingFirstPane(layout),
      agentStatusByPaneKey: { [makePaneKey('tab1', LEAF_2)]: workingHook(LEAF_2) },
      runtimePaneTitlesByTabId: { tab1: { 2: '❓ Claude needs your permission' } }
    }

    expect([...buildAttentionWorkspaceIds(state, BASE)]).toEqual(['w1'])
  })
})
