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

  it.each([
    {
      name: 'an incoming tab over an expanded chip',
      activeDrag: tab('incoming', 'another-pane'),
      collapsed: false,
      index: 4
    },
    {
      name: 'an incoming tab over a collapsed chip',
      activeDrag: tab('incoming', 'another-pane'),
      collapsed: true,
      index: 4
    },
    {
      name: 'an existing member over its own chip',
      activeDrag: tab('a'),
      collapsed: false,
      index: 3
    }
  ])('appends $name', ({ activeDrag, collapsed, index }) => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag,
        overData: { ...chip(), collapsed },
        targetGroup: { ...GROUP, tabClusters: [{ ...CLUSTER, collapsed }] },
        side: 'left'
      })
    ).toEqual({ index, clusterId: CLUSTER.id })
  })

  describe.each(['left', 'right'] as const)('whole-chip drops on the %s', (side) => {
    const sourceCluster = { ...CLUSTER, id: 'source-cluster', tabIds: ['one', 'two'] }
    const equalIdGroup: TabGroup = {
      ...GROUP,
      id: 'destination',
      tabClusters: [{ ...CLUSTER, id: 'same' }]
    }
    it.each([
      {
        name: 'a same-pane member',
        activeDrag: chip(sourceCluster.id),
        overData: tab('b'),
        targetGroup: {
          ...GROUP,
          tabOrder: ['one', 'two', ...GROUP.tabOrder],
          tabClusters: [sourceCluster, CLUSTER]
        }
      },
      {
        name: 'a cross-pane collapsed chip',
        activeDrag: chip('incoming-cluster', 'another-pane'),
        overData: { ...chip(), collapsed: true },
        targetGroup: { ...GROUP, tabClusters: [{ ...CLUSTER, collapsed: true }] }
      },
      {
        name: 'a cross-pane equal-id chip',
        activeDrag: chip('same', 'source'),
        overData: chip('same', equalIdGroup.id),
        targetGroup: equalIdGroup
      },
      {
        name: 'a cross-pane equal-id member',
        activeDrag: chip('same', 'source'),
        overData: tab('b', equalIdGroup.id),
        targetGroup: equalIdGroup
      }
    ])('places a chip at the whole-cluster boundary of $name', (testCase) => {
      expect(
        resolveTabClusterDropTarget({
          activeDrag: testCase.activeDrag,
          overData: testCase.overData,
          targetGroup: testCase.targetGroup,
          side
        })
      ).toEqual({ index: side === 'left' ? 1 : 4, clusterId: testCase.activeDrag.clusterId })
    })
  })

  it.each([
    { name: 'chip', overData: chip(), side: 'left' },
    { name: 'member', overData: tab('b'), side: 'right' }
  ] as const)('rejects chip drops onto their own $name', ({ overData, side }) => {
    expect(
      resolveTabClusterDropTarget({
        activeDrag: chip(),
        overData,
        targetGroup: GROUP,
        side
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
