import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { TerminalTab } from '../../../../shared/types'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'

type SelectorState = Parameters<typeof selectRuntimePaneTitlesForWorktree>[0]

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
})
