import type { StoreApi, UseBoundStore } from 'zustand'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TabCluster, TabGroup } from '../../../../../shared/tab-types'
import type { AppState } from '../../types'
import { createTestStore, makeTabGroup, makeUnifiedTab, seedStore } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { getHiddenClusterTabIds } from './tab-cluster-model'

createTabsSliceMockApi()

const WT = 'repo1::/tmp/cluster-transfer'
const SOURCE_CLUSTER: TabCluster = {
  id: 'source-cluster',
  name: 'Source',
  color: 'green',
  collapsed: true,
  tabIds: ['s1', 's2']
}
const TARGET_CLUSTER: TabCluster = {
  id: 'target-cluster',
  name: 'Destination',
  color: 'pink',
  collapsed: false,
  tabIds: ['a', 'b', 'c']
}
let store: UseBoundStore<StoreApi<AppState>>

function pane(groupId: string): TabGroup {
  const group = store.getState().groupsByWorktree[WT].find((item) => item.id === groupId)
  if (!group) {
    throw new Error(`Missing test pane: ${groupId}`)
  }
  return group
}

beforeEach(() => {
  store = createTestStore()
  const groups = [
    makeTabGroup({
      id: 'source',
      worktreeId: WT,
      activeTabId: 's2',
      tabOrder: ['s1', 's2', 'tail'],
      tabClusters: [SOURCE_CLUSTER]
    }),
    makeTabGroup({
      id: 'target',
      worktreeId: WT,
      activeTabId: 'after',
      tabOrder: ['before', 'a', 'b', 'c', 'after'],
      tabClusters: [TARGET_CLUSTER]
    })
  ]
  seedStore(store, {
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: 'source' },
    groupsByWorktree: { [WT]: groups },
    unifiedTabsByWorktree: {
      [WT]: groups.flatMap((group) =>
        group.tabOrder.map((id) => makeUnifiedTab({ id, worktreeId: WT, groupId: group.id }))
      )
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'source' },
        second: { type: 'leaf', groupId: 'target' }
      }
    }
  })
})

describe('single-tab cluster drops', () => {
  it('joins inside the destination span at the requested position without clipping members', () => {
    const publishedDestinations: string[][] = []
    const unsubscribe = store.subscribe((state) => {
      const destination = state.groupsByWorktree[WT].find((group) => group.id === 'target')
      if (destination?.tabOrder.includes('s2')) {
        publishedDestinations.push(destination.tabClusters?.[0].tabIds ?? [])
      }
    })
    try {
      expect(
        store
          .getState()
          .dropUnifiedTab('s2', { groupId: 'target', index: 2, clusterId: TARGET_CLUSTER.id })
      ).toBe(true)
    } finally {
      unsubscribe()
    }
    expect(pane('source').tabOrder).toEqual(['s1', 'tail'])
    expect(pane('source').tabClusters).toEqual([{ ...SOURCE_CLUSTER, tabIds: ['s1'] }])
    expect(pane('target').tabOrder).toEqual(['before', 'a', 's2', 'b', 'c', 'after'])
    expect(pane('target').tabClusters).toEqual([
      { ...TARGET_CLUSTER, tabIds: ['a', 's2', 'b', 'c'] }
    ])
    for (const members of publishedDestinations) {
      expect(members).toEqual(['a', 's2', 'b', 'c'])
    }
  })

  it('drops the sticky state when its member moves alone into a different cluster', () => {
    store.getState().setTabClusterCollapsed('source', SOURCE_CLUSTER.id, false)
    store.getState().setTabClusterCollapsed('source', SOURCE_CLUSTER.id, true)
    expect(pane('source').tabClusters?.[0].shownTabId).toBe('s2')
    expect(
      store
        .getState()
        .dropUnifiedTab('s2', { groupId: 'target', index: 2, clusterId: TARGET_CLUSTER.id })
    ).toBe(true)
    expect(pane('source').tabClusters).toEqual([{ ...SOURCE_CLUSTER, tabIds: ['s1'] }])
    expect(pane('target').tabClusters).toEqual([
      { ...TARGET_CLUSTER, tabIds: ['a', 's2', 'b', 'c'] }
    ])
    store.getState().activateTab('tail')
    expect([...getHiddenClusterTabIds(pane('source'))]).toEqual(['s1'])
  })
})

describe.each(['drop', 'move'] as const)('%s source cluster cleanup', (operation) => {
  function transfer(tabId: string, index: number): boolean {
    return operation === 'drop'
      ? store.getState().dropUnifiedTab(tabId, { groupId: 'target', index })
      : store.getState().moveUnifiedTabToGroup(tabId, 'target', { index })
  }

  it.each([1, 4])('leaves a nonmember ungrouped at boundary index %s', (index) => {
    expect(transfer('s2', index)).toBe(true)
    expect(pane('target').tabClusters).toEqual([TARGET_CLUSTER])
    expect(pane('target').tabOrder[index]).toBe('s2')
    expect(pane('source').tabClusters?.[0].tabIds).toEqual(['s1'])
  })

  it('removes the final source member without carrying its cluster record', () => {
    transfer('s2', 1)
    transfer('s1', 1)
    expect(pane('source').tabOrder).toEqual(['tail'])
    expect(Object.hasOwn(pane('source'), 'tabClusters')).toBe(false)
    expect(pane('target').tabClusters).toEqual([TARGET_CLUSTER])
  })
})

it('ignores destination membership for a new-split single-tab drop', () => {
  expect(
    store.getState().dropUnifiedTab('s2', {
      groupId: 'target',
      splitDirection: 'down',
      clusterId: TARGET_CLUSTER.id
    })
  ).toBe(true)
  const movedTab = store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === 's2')
  if (!movedTab) {
    throw new Error('Missing moved tab')
  }
  const splitPane = pane(movedTab.groupId)
  expect(splitPane.tabOrder).toEqual(['s2'])
  expect(Object.hasOwn(splitPane, 'tabClusters')).toBe(false)
  expect(pane('source').tabClusters?.[0].tabIds).toEqual(['s1'])
  expect(pane('target').tabClusters).toEqual([TARGET_CLUSTER])
})
