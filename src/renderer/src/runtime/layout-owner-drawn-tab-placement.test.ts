import { describe, expect, it } from 'vitest'
import type { TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { drawnTabPlacement } from './layout-owner-drawn-tab-placement'

const WT = 'wt-1'

function stateOf(groups: TabGroup[], layout: TabGroupLayoutNode) {
  return { groupsByWorktree: { [WT]: groups }, layoutByWorktree: { [WT]: layout } }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId: WT, activeTabId: tabOrder[0] ?? null, tabOrder }
}

describe('drawnTabPlacement', () => {
  const single = stateOf([group('G', ['a', 'b', 'c'])], { type: 'leaf', groupId: 'G' })

  it('places a tab drawn first at index 0', () => {
    expect(drawnTabPlacement(single, WT, 'G', 'a')).toEqual({ groupId: 'G', index: 0 })
  })

  it('places a middle tab after the tab before it', () => {
    expect(drawnTabPlacement(single, WT, 'G', 'b')).toEqual({ groupId: 'G', afterTabId: 'a' })
  })

  it('places the last tab after the tab before it', () => {
    expect(drawnTabPlacement(single, WT, 'G', 'c')).toEqual({ groupId: 'G', afterTabId: 'b' })
  })

  it('names only the group for a tab missing from the order', () => {
    expect(drawnTabPlacement(single, WT, 'G', 'z')).toEqual({ groupId: 'G' })
    expect(drawnTabPlacement(single, WT, 'missing-group', 'a')).toEqual({
      groupId: 'missing-group'
    })
  })

  it('carries the split for a tab opened to the side in its own new group', () => {
    const state = stateOf([group('G', ['a']), group('N', ['n'])], {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'G' },
      second: { type: 'leaf', groupId: 'N' }
    })
    expect(drawnTabPlacement(state, WT, 'N', 'n')).toEqual({
      groupId: 'N',
      index: 0,
      split: { besideGroupId: 'G', direction: 'right' }
    })
  })
})
