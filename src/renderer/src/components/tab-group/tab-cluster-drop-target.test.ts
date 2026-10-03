import { describe, expect, it } from 'vitest'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { resolveTabClusterDropTarget } from './tab-cluster-drop-target'
import type { TabClusterDragItemData, TabDragItemData } from './tab-drag-data'

const WT = 'wt-drop-target'
const CLUSTER: TabCluster = {
  id: 'cluster',
  name: 'Research',
  color: 'blue',
  collapsed: false,
  tabIds: ['a', 'b', 'c']
}
const GROUP: TabGroup = {
  id: 'pane',
  worktreeId: WT,
  activeTabId: 'b',
  tabOrder: ['left', 'a', 'b', 'c', 'right'],
  tabClusters: [CLUSTER]
}

function tab(unifiedTabId: string, groupId = GROUP.id): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId,
    unifiedTabId,
    visibleTabId: unifiedTabId,
    tabType: 'editor',
    label: unifiedTabId
  }
}

function chip(clusterId = CLUSTER.id, groupId = GROUP.id): TabClusterDragItemData {
  return {
    kind: 'tab-cluster',
    worktreeId: WT,
    groupId,
    clusterId,
    name: 'Research',
    color: 'blue',
    collapsed: false
  }
}

describe('tab cluster drop targets', () => {
  it.each(['pane', 'another-pane'])('joins strictly inside a span from %s', (sourceGroupId) => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: tab('right', sourceGroupId),
        overData: tab('b'),
        targetGroup: GROUP,
        side: 'left'
      })
    ).toEqual({ index: 2, clusterId: CLUSTER.id })
  })

  it.each([
    { moved: 'c', over: 'a', side: 'left', index: 1, clusterId: CLUSTER.id },
    { moved: 'a', over: 'c', side: 'right', index: 3, clusterId: CLUSTER.id },
    { moved: 'right', over: 'a', side: 'left', index: 1, clusterId: null },
    { moved: 'left', over: 'c', side: 'right', index: 3, clusterId: null }
  ] satisfies {
    moved: string
    over: string
    side: 'left' | 'right'
    index: number
    clusterId: string | null
  }[])('handles the $side boundary for $moved', ({ moved, over, side, index, clusterId }) => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: tab(moved),
        overData: tab(over),
        targetGroup: GROUP,
        side
      })
    ).toEqual({ index, clusterId })
  })

  it.each(['left', 'right'] as const)(
    'does not inherit cross-pane membership at a %s boundary',
    (side) => {
      expect(
        resolveTabClusterDropTarget({
          activeDrag: tab('incoming', 'another-pane'),
          overData: tab(side === 'left' ? 'a' : 'c'),
          targetGroup: GROUP,
          side
        })
      ).toEqual({ index: side === 'left' ? 1 : 4, clusterId: null })
    }
  )

  it.each([false, true])('appends a tab over a chip with collapsed=%s', (collapsed) => {
    const targetGroup = { ...GROUP, tabClusters: [{ ...CLUSTER, collapsed }] }
    expect(
      resolveTabClusterDropTarget({
        activeDrag: tab('incoming', 'another-pane'),
        overData: { ...chip(), collapsed },
        targetGroup,
        side: 'left'
      })
    ).toEqual({ index: 4, clusterId: CLUSTER.id })
  })

  it('appends an existing member over its own chip without losing membership', () => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: tab('a'),
        overData: chip(),
        targetGroup: GROUP,
        side: 'left'
      })
    ).toEqual({ index: 3, clusterId: CLUSTER.id })
  })

  it.each(['left', 'right'] as const)('places a chip %s of another whole cluster', (side) => {
    const sourceCluster = { ...CLUSTER, id: 'source-cluster', tabIds: ['one', 'two'] }
    const targetGroup = {
      ...GROUP,
      tabOrder: ['one', 'two', ...GROUP.tabOrder],
      tabClusters: [sourceCluster, CLUSTER]
    }
    expect(
      resolveTabClusterDropTarget({
        activeDrag: chip(sourceCluster.id),
        overData: tab('b'),
        targetGroup,
        side
      })
    ).toEqual({ index: side === 'left' ? 1 : 4, clusterId: sourceCluster.id })
  })

  it.each(['left', 'right'] as const)(
    'places a cross-pane chip %s of a collapsed target chip',
    (side) => {
      expect(
        resolveTabClusterDropTarget({
          activeDrag: chip('incoming-cluster', 'another-pane'),
          overData: { ...chip(), collapsed: true },
          targetGroup: { ...GROUP, tabClusters: [{ ...CLUSTER, collapsed: true }] },
          side
        })
      ).toEqual({ index: side === 'left' ? 1 : 4, clusterId: 'incoming-cluster' })
    }
  )

  it.each(['left', 'right'] as const)(
    'places a cross-pane equal-id chip at the target cluster’s %s boundary',
    (side) => {
      const targetGroup = {
        ...GROUP,
        id: 'destination',
        tabClusters: [{ ...CLUSTER, id: 'same' }]
      }
      for (const overData of [chip('same', targetGroup.id), tab('b', targetGroup.id)]) {
        expect(
          resolveTabClusterDropTarget({
            activeDrag: chip('same', 'source'),
            overData,
            targetGroup,
            side
          })
        ).toEqual({ index: side === 'left' ? 1 : 4, clusterId: 'same' })
      }
    }
  )

  it('rejects chip drops onto their own chip', () => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: chip(),
        overData: chip(),
        targetGroup: GROUP,
        side: 'left'
      })
    ).toBeNull()
  })

  it('rejects chip drops onto their own members', () => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: chip(),
        overData: tab('b'),
        targetGroup: GROUP,
        side: 'right'
      })
    ).toBeNull()
  })

  it('keeps tab-only post-removal insertion without clusters', () => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: tab('left'),
        overData: tab('b'),
        targetGroup: { ...GROUP, tabClusters: undefined },
        side: 'right'
      })
    ).toEqual({ index: 2, clusterId: null })
  })
})
