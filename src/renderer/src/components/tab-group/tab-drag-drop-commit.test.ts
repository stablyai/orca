/** @vitest-environment happy-dom */
import type { DragEndEvent } from '@dnd-kit/core'
import type { StoreApi, UseBoundStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import {
  clearHostSessionTabIdMappings,
  setHostSessionTabIdMapping
} from '../../runtime/web-session-tabs-sync/tracking-mappings'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  seedStore
} from '../../store/slices/store-test-helpers'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import { commitTabDragDrop } from './tab-drag-drop-commit'
import type { TabGroupPanelGeometrySnapshot } from './tab-group-panel-split-target'
import type {
  TabClusterDragItemData,
  TabDragItemData,
  TabPaneDropData,
  TabStripDragItemData
} from './tab-drag-data'

vi.mock('../tab-bar/web-runtime-tab-move-mirror', () => ({ mirrorWebRuntimeTabMove: vi.fn() }))

const WT = 'repo1::/tmp/cluster-drag'
const SOURCE_CLUSTER: TabCluster = {
  id: 'source-cluster',
  name: 'Source',
  color: 'blue',
  collapsed: true,
  tabIds: ['s-a', 's-b']
}
const TARGET_CLUSTER: TabCluster = {
  id: 'target-cluster',
  name: 'Target',
  color: 'red',
  collapsed: false,
  tabIds: ['t-a', 't-b', 't-c']
}
let store: UseBoundStore<StoreApi<AppState>>

function tab(id: string, groupId = 'source'): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId,
    unifiedTabId: id,
    visibleTabId: id,
    tabType: 'terminal',
    label: id
  }
}

function chip(groupId = 'source', cluster = SOURCE_CLUSTER): TabClusterDragItemData {
  return {
    kind: 'tab-cluster',
    worktreeId: WT,
    groupId,
    clusterId: cluster.id,
    name: cluster.name,
    color: cluster.color,
    collapsed: cluster.collapsed
  }
}

function event(
  activeData: TabStripDragItemData,
  overData: TabStripDragItemData | TabPaneDropData,
  x = 10,
  y = 10
): DragEndEvent {
  return {
    active: {
      id: 'active',
      data: { current: activeData },
      rect: { current: { initial: null, translated: null } }
    },
    over: {
      id: 'over',
      data: { current: overData },
      rect: new DOMRect(0, 0, 100, 32),
      disabled: false
    },
    delta: { x: 0, y: 0 },
    collisions: [],
    activatorEvent: new MouseEvent('pointerdown', { clientX: x, clientY: y })
  }
}

function commit(dragEvent: DragEndEvent, geometry: TabGroupPanelGeometrySnapshot | null = null) {
  const finishDrag = vi.fn()
  commitTabDragDrop({
    event: dragEvent,
    worktreeId: WT,
    dragGeometryRef: { current: geometry },
    dropUnifiedTab: store.getState().dropUnifiedTab,
    moveTabsInStrip: store.getState().moveTabsInStrip,
    moveTabCluster: store.getState().moveTabCluster,
    finishDrag
  })
  return finishDrag
}

function group(id: string): TabGroup {
  const result = store.getState().groupsByWorktree[WT].find((item) => item.id === id)
  if (!result) {
    throw new Error(`Missing test pane: ${id}`)
  }
  return result
}

function sourceGeometry(): TabGroupPanelGeometrySnapshot {
  const entry = {
    groupId: 'source',
    panelRect: new DOMRect(0, 0, 400, 600),
    bodyRect: new DOMRect(0, 32, 400, 568)
  }
  return { entries: [entry], byGroupId: new Map([['source', entry]]) }
}

beforeEach(() => {
  store = createTestStore()
  const groups = [
    makeTabGroup({
      id: 'source',
      worktreeId: WT,
      activeTabId: 's-tail',
      tabOrder: ['s-a', 's-b', 's-tail'],
      tabClusters: [SOURCE_CLUSTER]
    }),
    makeTabGroup({
      id: 'target',
      worktreeId: WT,
      activeTabId: 'right',
      tabOrder: ['left', 't-a', 't-b', 't-c', 'right'],
      tabClusters: [TARGET_CLUSTER]
    })
  ]
  seedStore(store, {
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: 'source' },
    groupsByWorktree: { [WT]: groups },
    unifiedTabsByWorktree: {
      [WT]: groups.flatMap((pane) =>
        pane.tabOrder.map((id) => makeUnifiedTab({ id, worktreeId: WT, groupId: pane.id }))
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
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
})

afterEach(() => {
  clearHostSessionTabIdMappings('remote', WT)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('tab cluster drag commits', () => {
  it('preserves tab-only reorder behavior without cluster metadata', () => {
    store.getState().ungroupTabCluster('source', SOURCE_CLUSTER.id)
    commit(event(tab('s-a'), tab('s-b'), 90))
    expect(group('source').tabOrder).toEqual(['s-b', 's-a', 's-tail'])
    expect(group('source').tabClusters).toBeUndefined()
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: 's-a',
      targetGroupId: 'source',
      tabOrder: ['s-b', 's-a', 's-tail']
    })
  })

  it('mirrors a mixed cluster reorder with a host-backed anchor instead of its local-only first member', () => {
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' })
    setHostSessionTabIdMapping(
      {
        environmentId: 'remote',
        worktreeId: WT,
        tabId: 's-b'
      },
      'host-s-b'
    )
    commit(event(chip(), tab('s-tail'), 90))
    expect(group('source').tabOrder).toEqual(['s-tail', 's-a', 's-b'])
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledTimes(1)
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: 's-b',
      targetGroupId: 'source',
      tabOrder: ['s-tail', 's-a', 's-b']
    })
  })

  it('joins a same-pane interior insertion atomically and mirrors the flat order', () => {
    commit(event(tab('s-tail'), tab('s-b')))
    expect(group('source').tabOrder).toEqual(['s-a', 's-tail', 's-b'])
    expect(group('source').tabClusters?.[0].tabIds).toEqual(['s-a', 's-tail', 's-b'])
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: 's-tail',
      targetGroupId: 'source',
      tabOrder: ['s-a', 's-tail', 's-b']
    })
  })

  it('keeps a cross-pane interior slot while transferring membership', () => {
    const finishDrag = commit(event(tab('s-b'), tab('t-b', 'target')))
    expect(group('source').tabClusters?.[0].tabIds).toEqual(['s-a'])
    expect(group('target').tabOrder).toEqual(['left', 't-a', 's-b', 't-b', 't-c', 'right'])
    expect(group('target').tabClusters?.[0].tabIds).toEqual(['t-a', 's-b', 't-b', 't-c'])
    expect(finishDrag).toHaveBeenCalledWith(false, tab('s-b'))
  })

  it('appends over a collapsed chip rather than placing before its hidden members', () => {
    store.getState().setTabClusterCollapsed('target', TARGET_CLUSTER.id, true)
    commit(event(tab('s-tail'), chip('target', { ...TARGET_CLUSTER, collapsed: true })))
    expect(group('target').tabOrder).toEqual(['left', 't-a', 't-b', 't-c', 's-tail', 'right'])
    expect(group('target').tabClusters?.[0]).toMatchObject({
      collapsed: true,
      tabIds: ['t-a', 't-b', 't-c', 's-tail']
    })
  })

  it('reorders all chip members, including hidden tabs, within their pane', () => {
    commit(event(chip(), tab('s-tail'), 90))
    expect(group('source').tabOrder).toEqual(['s-tail', 's-a', 's-b'])
    expect(group('source').tabClusters?.[0]).toEqual(SOURCE_CLUSTER)
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledTimes(1)
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: 's-a',
      targetGroupId: 'source',
      tabOrder: ['s-tail', 's-a', 's-b']
    })
  })

  it('moves a chip after another whole cluster without merging and mirrors each member', () => {
    commit(event(chip(), tab('t-b', 'target'), 90))
    expect(group('source').tabOrder).toEqual(['s-tail'])
    expect(group('source').tabClusters).toBeUndefined()
    expect(group('target').tabOrder).toEqual(['left', 't-a', 't-b', 't-c', 's-a', 's-b', 'right'])
    expect(group('target').tabClusters).toEqual([TARGET_CLUSTER, SOURCE_CLUSTER])
    expect(vi.mocked(mirrorWebRuntimeTabMove).mock.calls.map(([move]) => move)).toEqual([
      { kind: 'move-to-group', worktreeId: WT, tabId: 's-a', targetGroupId: 'target', index: 4 },
      { kind: 'move-to-group', worktreeId: WT, tabId: 's-b', targetGroupId: 'target', index: 5 }
    ])
  })

  it.each(['chip', 'member'] as const)(
    'moves an equal-id cluster across panes via its %s without merging the records',
    (hoveredKind) => {
      const sourceCluster = { ...SOURCE_CLUSTER, id: 'same', shownTabId: 's-a' }
      const targetCluster = { ...TARGET_CLUSTER, id: 'same' }
      store.setState({
        groupsByWorktree: {
          [WT]: [
            { ...group('source'), tabClusters: [sourceCluster] },
            { ...group('target'), tabClusters: [targetCluster] }
          ]
        }
      })
      const overData = hoveredKind === 'chip' ? chip('target', targetCluster) : tab('t-b', 'target')
      commit(event(chip('source', sourceCluster), overData, 90))
      expect(group('source').tabOrder).toEqual(['s-tail'])
      expect(group('source').tabClusters).toBeUndefined()
      expect(group('target').tabOrder).toEqual(['left', 't-a', 't-b', 't-c', 's-a', 's-b', 'right'])
      expect(group('target').tabClusters?.find((cluster) => cluster.id === 'same')).toEqual(
        targetCluster
      )
      const movedCluster = group('target').tabClusters?.find((cluster) =>
        cluster.tabIds.includes('s-a')
      )
      expect(movedCluster).toMatchObject({
        name: 'Source',
        color: 'blue',
        collapsed: true,
        shownTabId: 's-a',
        tabIds: ['s-a', 's-b']
      })
      expect(movedCluster?.id).not.toBe('same')
    }
  )

  it('moves a chip to a pane body with its metadata intact', () => {
    commit(event(chip(), { kind: 'pane-body', worktreeId: WT, groupId: 'target' }))
    expect(group('target').tabOrder).toEqual(['left', 't-a', 't-b', 't-c', 'right', 's-a', 's-b'])
    expect(group('target').tabClusters).toEqual([TARGET_CLUSTER, SOURCE_CLUSTER])
  })

  it('moves a local chip into a new edge split with all hidden members', () => {
    commit(
      event(chip(), { kind: 'pane-body', worktreeId: WT, groupId: 'source' }, 398, 300),
      sourceGeometry()
    )
    expect(group('source').tabOrder).toEqual(['s-tail'])
    const splitPane = store
      .getState()
      .groupsByWorktree[WT].find((pane) => pane.id !== 'source' && pane.id !== 'target')
    expect(splitPane?.tabOrder).toEqual(['s-a', 's-b'])
    expect(splitPane?.tabClusters).toEqual([SOURCE_CLUSTER])
  })

  it('cancels mirrored chip edge splits without falling through to a body move', () => {
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' })
    const before = store.getState().groupsByWorktree[WT]
    const finishDrag = commit(
      event(chip(), { kind: 'pane-body', worktreeId: WT, groupId: 'source' }, 398, 300),
      sourceGeometry()
    )
    expect(store.getState().groupsByWorktree[WT]).toBe(before)
    expect(finishDrag).toHaveBeenCalledWith(true)
    expect(mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })
})
