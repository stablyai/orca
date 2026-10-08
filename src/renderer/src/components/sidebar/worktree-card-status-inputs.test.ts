import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/terminal-tab-types'
import {
  EMPTY_LIVE_PTY_IDS,
  EMPTY_PANE_FOREGROUND_AGENTS,
  EMPTY_RUNTIME_PANE_TITLES,
  EMPTY_TERMINAL_LAYOUT_ROOTS,
  selectLivePtyIdsForWorktree,
  selectPaneForegroundAgentsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectTerminalLayoutRootsForWorktrees,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'

type SelectorState = Parameters<typeof selectRuntimePaneTitlesForWorktree>[0]
type LayoutRootSelectorState = Parameters<typeof selectTerminalLayoutRootsForWorktree>[0]

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeLayout(root: TerminalPaneLayoutNode, ptyId: string): TerminalLayoutSnapshot {
  return {
    root,
    activeLeafId: root.type === 'leaf' ? root.leafId : null,
    expandedLeafId: null,
    ptyIdsByLeafId: root.type === 'leaf' ? { [root.leafId]: ptyId } : {}
  }
}

describe('worktree card status input selectors', () => {
  it('changes when this worktree receives a new live PTY id list', () => {
    const worktreeId = 'repo1::/path/wt1'
    const state: SelectorState = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      }
    }
    const updated: SelectorState = {
      ...state,
      ptyIdsByTabId: {
        'tab-1': ['pty-2']
      }
    }

    expect(
      shallow(
        selectLivePtyIdsForWorktree(state, worktreeId),
        selectLivePtyIdsForWorktree(updated, worktreeId)
      )
    ).toBe(false)
  })

  it('stays shallow-equal when wake updates only PTY bindings inside terminal layouts', () => {
    const worktreeId = 'repo1::/path/wt1'
    const root: TerminalPaneLayoutNode = {
      type: 'leaf',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
    const state: LayoutRootSelectorState = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(root, 'pty-before')
      }
    }
    const wakeBindingUpdate: LayoutRootSelectorState = {
      ...state,
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(root, 'pty-after')
      }
    }

    // Why: waking a slept pane rewrites ptyIdsByLeafId several times. Status
    // heuristics only need the layout root, so binding-only churn should not
    // invalidate every sidebar card or section summary.
    expect(
      shallow(
        selectTerminalLayoutRootsForWorktree(state, worktreeId),
        selectTerminalLayoutRootsForWorktree(wakeBindingUpdate, worktreeId)
      )
    ).toBe(true)
    expect(
      shallow(
        selectTerminalLayoutRootsForWorktrees(state, [worktreeId]),
        selectTerminalLayoutRootsForWorktrees(wakeBindingUpdate, [worktreeId])
      )
    ).toBe(true)
  })

  // Why: zustand re-runs every mounted card's selector on every store write, so
  // a fresh record per call multiplies by (visible cards x writes/sec).
  it('returns one identity per store generation instead of rebuilding per call', () => {
    const worktreeId = 'repo1::/path/wt1'
    const state: SelectorState & LayoutRootSelectorState = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'codex [working]' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(
          { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
          'pty-1'
        )
      }
    }

    expect(selectRuntimePaneTitlesForWorktree(state, worktreeId)).toBe(
      selectRuntimePaneTitlesForWorktree(state, worktreeId)
    )
    expect(selectLivePtyIdsForWorktree(state, worktreeId)).toBe(
      selectLivePtyIdsForWorktree(state, worktreeId)
    )
    expect(selectTerminalLayoutRootsForWorktree(state, worktreeId)).toBe(
      selectTerminalLayoutRootsForWorktree(state, worktreeId)
    )
  })

  it('carries the same identity across unrelated pane-title and PTY churn', () => {
    const worktreeId = 'repo1::/path/wt1'
    const state: SelectorState = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'codex [working]' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    }
    const unrelatedUpdate: SelectorState = {
      ...state,
      runtimePaneTitlesByTabId: {
        ...state.runtimePaneTitlesByTabId,
        'other-tab': { 0: 'claude [permission]' }
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, 'other-tab': ['pty-other'] }
    }

    expect(selectRuntimePaneTitlesForWorktree(state, worktreeId)).toBe(
      selectRuntimePaneTitlesForWorktree(unrelatedUpdate, worktreeId)
    )
    expect(selectLivePtyIdsForWorktree(state, worktreeId)).toBe(
      selectLivePtyIdsForWorktree(unrelatedUpdate, worktreeId)
    )
  })

  it('returns the shared frozen empty for a worktree with no tabs', () => {
    const state: SelectorState & LayoutRootSelectorState = {
      tabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    }

    expect(selectRuntimePaneTitlesForWorktree(state, 'missing')).toBe(EMPTY_RUNTIME_PANE_TITLES)
    expect(selectLivePtyIdsForWorktree(state, 'missing')).toBe(EMPTY_LIVE_PTY_IDS)
    expect(selectTerminalLayoutRootsForWorktree(state, 'missing')).toBe(EMPTY_TERMINAL_LAYOUT_ROOTS)
    expect(Object.isFrozen(EMPTY_RUNTIME_PANE_TITLES)).toBe(true)
    expect(Object.isFrozen(EMPTY_LIVE_PTY_IDS)).toBe(true)
    expect(Object.isFrozen(EMPTY_TERMINAL_LAYOUT_ROOTS)).toBe(true)
  })

  it("selects only this worktree's pane foreground reads, keeping identity across other writes", () => {
    const worktreeId = 'repo1::/path/wt1'
    const ownPaneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const ownEntry = { agent: 'codex' as const, shellForeground: false }
    const state: Parameters<typeof selectPaneForegroundAgentsForWorktree>[0] = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)],
        other: [makeTab('tab-2', 'other')]
      },
      paneForegroundAgentByPaneKey: {
        [ownPaneKey]: ownEntry,
        'tab-2:22222222-2222-4222-8222-222222222222': { agent: 'claude', shellForeground: false }
      }
    }
    const selected = selectPaneForegroundAgentsForWorktree(state, worktreeId)
    expect(selected).toEqual({ [ownPaneKey]: ownEntry })

    const otherWrite = {
      ...state,
      paneForegroundAgentByPaneKey: {
        ...state.paneForegroundAgentByPaneKey,
        'tab-2:22222222-2222-4222-8222-222222222222': { agent: null, shellForeground: true }
      }
    }
    expect(selectPaneForegroundAgentsForWorktree(otherWrite, worktreeId)).toBe(selected)
    expect(selectPaneForegroundAgentsForWorktree(otherWrite, 'missing')).toBe(
      EMPTY_PANE_FOREGROUND_AGENTS
    )
  })

  it('groups foreground reads by tab, including split panes, and skips worktrees with no tabs', () => {
    const splitLeft = 'tab-1:11111111-1111-4111-8111-111111111111'
    const splitRight = 'tab-1:33333333-3333-4333-8333-333333333333'
    const ownSecondTab = 'tab-3:44444444-4444-4444-8444-444444444444'
    const state: Parameters<typeof selectPaneForegroundAgentsForWorktree>[0] = {
      tabsByWorktree: {
        wt1: [makeTab('tab-1', 'wt1'), makeTab('tab-3', 'wt1')],
        wt2: [makeTab('tab-2', 'wt2')],
        empty: []
      },
      paneForegroundAgentByPaneKey: {
        [splitLeft]: { agent: 'codex', shellForeground: false },
        'tab-2:22222222-2222-4222-8222-222222222222': { agent: 'claude', shellForeground: false },
        [splitRight]: { agent: null, shellForeground: true },
        [ownSecondTab]: { agent: 'gemini', shellForeground: false },
        'not-a-pane-key': { agent: 'grok', shellForeground: false }
      }
    }

    const selected = selectPaneForegroundAgentsForWorktree(state, 'wt1')
    expect(selected).toEqual({
      [splitLeft]: state.paneForegroundAgentByPaneKey?.[splitLeft],
      [splitRight]: state.paneForegroundAgentByPaneKey?.[splitRight],
      [ownSecondTab]: state.paneForegroundAgentByPaneKey?.[ownSecondTab]
    })
    expect(Object.keys(selectPaneForegroundAgentsForWorktree(state, 'wt2'))).toEqual([
      'tab-2:22222222-2222-4222-8222-222222222222'
    ])
    expect(selectPaneForegroundAgentsForWorktree(state, 'empty')).toBe(EMPTY_PANE_FOREGROUND_AGENTS)
    expect(
      selectPaneForegroundAgentsForWorktree({ ...state, paneForegroundAgentByPaneKey: {} }, 'wt1')
    ).toBe(EMPTY_PANE_FOREGROUND_AGENTS)
  })
})
