import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'
import {
  selectLivePtyIdsForWorktree,
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
  it('stays shallow-equal when unrelated tabs receive PTY ids or pane titles', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneTitles = { 0: 'codex [working]' }
    const ptyIds = ['pty-1']
    const state: SelectorState = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      runtimePaneTitlesByTabId: {
        'tab-1': paneTitles
      },
      ptyIdsByTabId: {
        'tab-1': ptyIds
      }
    }
    const unrelatedUpdate: SelectorState = {
      ...state,
      runtimePaneTitlesByTabId: {
        ...state.runtimePaneTitlesByTabId,
        'other-tab': { 0: 'claude [permission]' }
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        'other-tab': ['pty-other']
      }
    }

    // Why: WorktreeCard wraps these selectors in useShallow. The selected
    // maps must expose stable per-tab values at the top level so unrelated
    // PTY/title churn does not re-render every sidebar card.
    expect(
      shallow(
        selectRuntimePaneTitlesForWorktree(state, worktreeId),
        selectRuntimePaneTitlesForWorktree(unrelatedUpdate, worktreeId)
      )
    ).toBe(true)
    expect(
      shallow(
        selectLivePtyIdsForWorktree(state, worktreeId),
        selectLivePtyIdsForWorktree(unrelatedUpdate, worktreeId)
      )
    ).toBe(true)
  })

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
})
