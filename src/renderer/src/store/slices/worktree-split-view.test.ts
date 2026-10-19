import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  clampWorktreeSplitViewRatio,
  isWorktreeSurfaceShown,
  selectWorktreeSplitPartnerId,
  splitViewPairAfterHostTwinPurge,
  splitViewPairAfterRemoval,
  splitViewPairAfterRename
} from './worktree-split-view'

describe('worktree split view', () => {
  it('pairs the active worktree on the left with the opened one on the right', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: 'wt-a', activeWorkspaceExecutionHostId: null })

    expect(store.getState().openWorktreeInSplitView('wt-b', null)).toBe(true)
    expect(store.getState().worktreeSplitViewPair).toEqual({
      leftWorktreeId: 'wt-a',
      leftExecutionHostId: null,
      rightWorktreeId: 'wt-b',
      rightExecutionHostId: null
    })
  })

  it('refuses to pair a worktree with itself or with no active worktree', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: null })
    expect(store.getState().openWorktreeInSplitView('wt-b')).toBe(false)

    store.setState({ activeWorktreeId: 'wt-b' })
    expect(store.getState().openWorktreeInSplitView('wt-b')).toBe(false)
    expect(store.getState().worktreeSplitViewPair).toBeNull()
  })

  it('names the partner only while the active worktree is one of the pair', () => {
    const pair = {
      leftWorktreeId: 'wt-a',
      leftExecutionHostId: null,
      rightWorktreeId: 'wt-b',
      rightExecutionHostId: null
    }
    expect(
      selectWorktreeSplitPartnerId({ worktreeSplitViewPair: pair, activeWorktreeId: 'wt-a' })
    ).toBe('wt-b')
    expect(
      selectWorktreeSplitPartnerId({ worktreeSplitViewPair: pair, activeWorktreeId: 'wt-b' })
    ).toBe('wt-a')
    expect(
      selectWorktreeSplitPartnerId({ worktreeSplitViewPair: pair, activeWorktreeId: 'wt-c' })
    ).toBeNull()
  })

  it('shows the partner surface only in the terminal view', () => {
    const ids = { renderedActiveWorktreeId: 'wt-a', splitPartnerWorktreeId: 'wt-b' }
    expect(isWorktreeSurfaceShown({ activeView: 'terminal', ...ids }, 'wt-b')).toBe(true)
    expect(isWorktreeSurfaceShown({ activeView: 'settings', ...ids }, 'wt-b')).toBe(false)
    expect(isWorktreeSurfaceShown({ activeView: 'terminal', ...ids }, 'wt-c')).toBe(false)
  })

  it('ends the split when a paired worktree is removed and re-points it on rename', () => {
    const worktreeSplitViewPair = {
      leftWorktreeId: 'wt-a',
      leftExecutionHostId: null,
      rightWorktreeId: 'wt-b',
      rightExecutionHostId: null
    }
    expect(splitViewPairAfterRemoval({ worktreeSplitViewPair }, new Set(['wt-b']))).toEqual({
      worktreeSplitViewPair: null
    })
    expect(splitViewPairAfterRemoval({ worktreeSplitViewPair }, new Set(['wt-c']))).toEqual({})
    expect(splitViewPairAfterRename({ worktreeSplitViewPair }, 'wt-a', 'wt-a2')).toEqual({
      worktreeSplitViewPair: { ...worktreeSplitViewPair, leftWorktreeId: 'wt-a2' }
    })
  })

  it('ends the split only when the purged host owned a paired twin side', () => {
    const worktreeSplitViewPair = {
      leftWorktreeId: 'wt-a',
      leftExecutionHostId: null,
      rightWorktreeId: 'wt-b',
      rightExecutionHostId: 'ssh:box' as const
    }
    const twins = new Set(['wt-b'])
    expect(splitViewPairAfterHostTwinPurge({ worktreeSplitViewPair }, twins, 'ssh:box')).toEqual({
      worktreeSplitViewPair: null
    })
    expect(splitViewPairAfterHostTwinPurge({ worktreeSplitViewPair }, twins, 'ssh:other')).toEqual(
      {}
    )
  })

  it('clamps the divider ratio', () => {
    expect(clampWorktreeSplitViewRatio(0.01)).toBe(0.15)
    expect(clampWorktreeSplitViewRatio(0.99)).toBe(0.85)
    expect(clampWorktreeSplitViewRatio(Number.NaN)).toBe(0.5)
  })
})
