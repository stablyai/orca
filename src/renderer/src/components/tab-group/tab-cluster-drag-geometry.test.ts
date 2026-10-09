/** @vitest-environment happy-dom */
import type { DragEndEvent } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import {
  canDropTabIntoPaneBody,
  getTabClusterSortableId,
  isTabDragData,
  type TabClusterDragItemData,
  type TabDragItemData,
  type TabStripDragItemData
} from './tab-drag-data'
import { resolveTabInsertion } from './tab-insertion'
import {
  resolveActivePaneColumnSplitTarget,
  resolvePanelEdgePaneColumnSplit,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'

const WT = 'cluster-drag-geometry'
const CLUSTER: TabCluster = {
  id: 'cluster',
  name: 'Group',
  color: 'orange',
  collapsed: false,
  tabIds: ['a', 'b', 'c']
}
const GROUP: TabGroup = {
  id: 'pane',
  worktreeId: WT,
  activeTabId: 'b',
  tabOrder: ['a', 'b', 'c'],
  tabClusters: [CLUSTER]
}
const CHIP: TabClusterDragItemData = {
  kind: 'tab-cluster',
  worktreeId: WT,
  groupId: 'pane',
  clusterId: CLUSTER.id,
  name: CLUSTER.name,
  color: CLUSTER.color,
  collapsed: CLUSTER.collapsed
}

function tab(id: string, groupId = 'pane'): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId,
    unifiedTabId: id,
    visibleTabId: id,
    tabType: 'editor',
    label: id
  }
}

function dragEvent(
  activeData: TabStripDragItemData,
  overData: TabStripDragItemData | null
): DragEndEvent {
  return {
    active: {
      id: 'active',
      data: { current: activeData },
      rect: { current: { initial: null, translated: null } }
    },
    over: overData
      ? {
          id: 'over',
          data: { current: overData },
          rect: new DOMRect(0, 0, 100, 32),
          disabled: false
        }
      : null,
    collisions: [],
    delta: { x: 0, y: 0 },
    activatorEvent: new MouseEvent('pointerdown')
  }
}

function geometry(): TabGroupPanelGeometrySnapshot {
  const entry = {
    groupId: GROUP.id,
    panelRect: new DOMRect(0, 0, 400, 600),
    bodyRect: new DOMRect(0, 32, 400, 568)
  }
  return { entries: [entry], byGroupId: new Map([[GROUP.id, entry]]) }
}

describe('cluster pane edge geometry', () => {
  it('rejects splitting every tab of a pane into its own body', () => {
    expect(
      canDropTabIntoPaneBody({
        activeDrag: CHIP,
        groupsByWorktree: { [WT]: [GROUP] },
        overGroupId: GROUP.id,
        worktreeId: WT
      })
    ).toBe(false)
    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: CHIP,
        targetGroupId: GROUP.id,
        worktreeId: WT,
        groupsByWorktree: { [WT]: [GROUP] },
        layoutByWorktree: {},
        pointer: { x: 398, y: 300 },
        panelRect: new DOMRect(0, 0, 400, 600),
        bodyRect: new DOMRect(0, 32, 400, 568)
      })
    ).toBeNull()
  })

  it('resolves geometry-only cluster splits when a source tab will remain', () => {
    expect(
      resolveActivePaneColumnSplitTarget({
        event: dragEvent(CHIP, null),
        groupsByWorktree: { [WT]: [{ ...GROUP, tabOrder: [...GROUP.tabOrder, 'tail'] }] },
        layoutByWorktree: {},
        worktreeId: WT,
        geometry: geometry(),
        getDragPointer: () => ({ x: 398, y: 300 })
      })
    ).toMatchObject({ groupId: GROUP.id, zone: 'right' })
  })

  it('keeps chip strip hovers out of pane split zones', () => {
    expect(
      resolveActivePaneColumnSplitTarget({
        event: dragEvent({ ...CHIP, groupId: 'other-pane', clusterId: 'other-cluster' }, CHIP),
        groupsByWorktree: { [WT]: [GROUP] },
        layoutByWorktree: {},
        worktreeId: WT,
        geometry: geometry(),
        getDragPointer: () => ({ x: 398, y: 10 })
      })
    ).toBeNull()
  })
})

describe('cluster strip insertion indicators', () => {
  it.each([
    {
      name: 'a nonmember outside its chip',
      activeDrag: tab('incoming', 'other-pane'),
      visibleTabId: getTabClusterSortableId(GROUP.id, CLUSTER.id)
    },
    { name: 'a member inside its chip', activeDrag: tab('c'), visibleTabId: 'a' }
  ])('marks the left boundary for $name', ({ activeDrag, visibleTabId }) => {
    expect(
      resolveTabInsertion(
        dragEvent(activeDrag, tab('a')),
        isTabDragData,
        () => ({ x: 10, y: 10 }),
        GROUP
      )
    ).toEqual({ groupId: GROUP.id, visibleTabId, side: 'left' })
  })

  it.each([
    { name: 'an expanded chip', collapsed: false, activeTabId: 'b', visibleTabId: 'c' },
    {
      name: 'a collapsed chip with an active member',
      collapsed: true,
      activeTabId: 'b',
      visibleTabId: 'b'
    },
    {
      name: 'a collapsed chip without an active member',
      collapsed: true,
      activeTabId: 'tail',
      visibleTabId: getTabClusterSortableId(GROUP.id, CLUSTER.id)
    }
  ])('marks the append edge for $name', ({ collapsed, activeTabId, visibleTabId }) => {
    const target = {
      ...GROUP,
      activeTabId,
      tabOrder: [...GROUP.tabOrder, 'tail'],
      tabClusters: [{ ...CLUSTER, collapsed }]
    }
    expect(
      resolveTabInsertion(
        dragEvent(tab('incoming', 'other-pane'), { ...CHIP, collapsed }),
        isTabDragData,
        () => ({ x: 10, y: 10 }),
        target
      )
    ).toEqual({ groupId: GROUP.id, visibleTabId, side: 'right' })
  })

  it.each(['left', 'right'] as const)(
    'marks the %s edge of the whole hovered cluster for a chip drag',
    (side) => {
      expect(
        resolveTabInsertion(
          dragEvent({ ...CHIP, groupId: 'other-pane', clusterId: 'other-cluster' }, tab('b')),
          isTabDragData,
          () => ({ x: side === 'left' ? 10 : 90, y: 10 }),
          GROUP
        )
      ).toEqual({
        groupId: GROUP.id,
        visibleTabId: side === 'left' ? getTabClusterSortableId(GROUP.id, CLUSTER.id) : 'c',
        side
      })
    }
  )

  it.each(['left', 'right'] as const)(
    'marks the %s destination chip edge for an equal-id cluster from another pane',
    (side) => {
      const target: TabGroup = {
        ...GROUP,
        id: 'destination',
        activeTabId: 'tail',
        tabOrder: [...GROUP.tabOrder, 'tail'],
        tabClusters: [{ ...CLUSTER, id: 'same', collapsed: true }]
      }
      expect(
        resolveTabInsertion(
          dragEvent(
            { ...CHIP, groupId: 'source', clusterId: 'same' },
            { ...CHIP, groupId: target.id, clusterId: 'same', collapsed: true }
          ),
          isTabDragData,
          () => ({ x: side === 'left' ? 10 : 90, y: 10 }),
          target
        )
      ).toEqual({
        groupId: target.id,
        visibleTabId: getTabClusterSortableId(target.id, 'same'),
        side
      })
    }
  )

  it.each([
    { name: 'chip', overData: CHIP, x: 10 },
    { name: 'member', overData: tab('b'), x: 90 }
  ])('suppresses a chip insertion indicator over its own $name', ({ overData, x }) => {
    expect(
      resolveTabInsertion(dragEvent(CHIP, overData), isTabDragData, () => ({ x, y: 10 }), GROUP)
    ).toBeNull()
  })
})
