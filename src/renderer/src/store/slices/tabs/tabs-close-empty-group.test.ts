import { expect, it } from 'vitest'
import { useAppStore } from '../../index'
import { makeTabGroup, makeUnifiedTab } from './tab-group.test-fixture'

const WT = 'wt-close-empty-group'

// Invariant: a group closes iff no live tab names it in groupId; its tabOrder may have drifted.
it.each([
  { case: 'lists only a sibling-owned tab', ownsTab: false, tabOrder: ['sibling', 'ghost'] },
  { case: 'owns a listed tab', ownsTab: true, tabOrder: ['sibling', 'own'] },
  { case: 'owns a tab its tabOrder lost', ownsTab: true, tabOrder: [] }
])('closeEmptyGroup when the group $case', ({ ownsTab, tabOrder }) => {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WT]: [
        makeUnifiedTab({ id: 'sibling', worktreeId: WT, groupId: 'right' }),
        ...(ownsTab ? [makeUnifiedTab({ id: 'own', worktreeId: WT, groupId: 'left' })] : [])
      ]
    },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({ id: 'left', worktreeId: WT, tabOrder }),
        makeTabGroup({ id: 'right', worktreeId: WT, tabOrder: ['sibling'], activeTabId: 'sibling' })
      ]
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      }
    },
    activeGroupIdByWorktree: { [WT]: 'left' }
  })

  expect(useAppStore.getState().closeEmptyGroup(WT, 'left')).toBe(!ownsTab)
  const state = useAppStore.getState()
  expect(state.groupsByWorktree[WT].map((group) => group.id)).toEqual(
    ownsTab ? ['left', 'right'] : ['right']
  )
  if (!ownsTab) {
    expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: 'right' })
    expect(state.unifiedTabsByWorktree[WT].map((tab) => tab.groupId)).toEqual(['right'])
  }
})
