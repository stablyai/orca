/** @vitest-environment happy-dom */
import type { DragEndEvent } from '@dnd-kit/core'
import type { StoreApi, UseBoundStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TabCluster } from '../../../../shared/tab-types'
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

function commit(
  dragEvent: DragEndEvent,
  geometry: TabGroupPanelGeometrySnapshot | null = null,
  worktreeId = WT
) {
  const state = store.getState()
  const dropUnifiedTab = vi.spyOn(state, 'dropUnifiedTab')
  const moveTabsInStrip = vi.spyOn(state, 'moveTabsInStrip')
  const moveTabCluster = vi.spyOn(state, 'moveTabCluster')
  const finishDrag = vi.fn()
  commitTabDragDrop({
    event: dragEvent,
    worktreeId,
    dragGeometryRef: { current: geometry },
    dropUnifiedTab,
    moveTabsInStrip,
    moveTabCluster,
    finishDrag
  })
  return { dropUnifiedTab, moveTabsInStrip, moveTabCluster, finishDrag }
}

function paneGeometry(groupId: string): TabGroupPanelGeometrySnapshot {
  const entry = {
    groupId,
    panelRect: new DOMRect(0, 0, 400, 600),
    bodyRect: new DOMRect(0, 32, 400, 568)
  }
  return { entries: [entry], byGroupId: new Map([[groupId, entry]]) }
}

function seedDragPanes(worktreeId: string): void {
  const groups = [
    makeTabGroup({
      id: 'source',
      worktreeId,
      activeTabId: 's-tail',
      tabOrder: ['s-a', 's-b', 's-tail'],
      tabClusters: [SOURCE_CLUSTER]
    }),
    makeTabGroup({
      id: 'target',
      worktreeId,
      activeTabId: 'right',
      tabOrder: ['left', 't-a', 't-b', 't-c', 'right'],
      tabClusters: [TARGET_CLUSTER]
    })
  ]
  seedStore(store, {
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree: { [worktreeId]: 'source' },
    groupsByWorktree: { [worktreeId]: groups },
    unifiedTabsByWorktree: {
      [worktreeId]: groups.flatMap((pane) =>
        pane.tabOrder.map((id) => makeUnifiedTab({ id, worktreeId, groupId: pane.id }))
      )
    },
    layoutByWorktree: {
      [worktreeId]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'source' },
        second: { type: 'leaf', groupId: 'target' }
      }
    }
  })
}

beforeEach(() => {
  store = createTestStore()
  seedDragPanes(WT)
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
})

afterEach(() => {
  clearHostSessionTabIdMappings('remote', WT)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('tab cluster drag commits', () => {
  it.each([
    {
      name: 'a same-pane interior tab drop',
      activeDrag: tab('s-tail'),
      overData: tab('s-b'),
      x: 10,
      movedTabIds: ['s-tail'],
      tabOrder: ['s-a', 's-tail', 's-b']
    },
    {
      name: 'a same-pane collapsed chip reorder',
      activeDrag: chip(),
      overData: tab('s-tail'),
      x: 90,
      movedTabIds: ['s-a', 's-b'],
      tabOrder: ['s-tail', 's-a', 's-b']
    }
  ])('routes $name through strip movement and mirrors its order', (testCase) => {
    const { moveTabsInStrip, dropUnifiedTab, moveTabCluster, finishDrag } = commit(
      event(testCase.activeDrag, testCase.overData, testCase.x)
    )
    expect(moveTabsInStrip.mock.calls).toEqual([
      ['source', testCase.movedTabIds, { index: 1, clusterId: SOURCE_CLUSTER.id }]
    ])
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(moveTabCluster).not.toHaveBeenCalled()
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledTimes(1)
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: testCase.movedTabIds[0],
      targetGroupId: 'source',
      tabOrder: testCase.tabOrder
    })
    expect(finishDrag.mock.calls).toEqual([[true]])
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
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledTimes(1)
    expect(mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'reorder',
      worktreeId: WT,
      tabId: 's-b',
      targetGroupId: 'source',
      tabOrder: ['s-tail', 's-a', 's-b']
    })
  })

  it('routes a cross-pane interior tab drop with the resolved slot and membership', () => {
    const { dropUnifiedTab, moveTabsInStrip, moveTabCluster, finishDrag } = commit(
      event(tab('s-b'), tab('t-b', 'target'))
    )
    expect(dropUnifiedTab.mock.calls).toEqual([
      ['s-b', { groupId: 'target', index: 2, clusterId: TARGET_CLUSTER.id }]
    ])
    expect(moveTabsInStrip).not.toHaveBeenCalled()
    expect(moveTabCluster).not.toHaveBeenCalled()
    expect(finishDrag.mock.calls).toEqual([[false, tab('s-b')]])
  })

  it.each([
    {
      name: 'a cross-pane strip',
      overData: tab('t-b', 'target'),
      target: { groupId: 'target', index: 4 },
      index: 4
    },
    {
      name: 'another pane body',
      overData: { kind: 'pane-body', worktreeId: WT, groupId: 'target' },
      target: { groupId: 'target' },
      index: 5
    }
  ] satisfies {
    name: string
    overData: TabStripDragItemData | TabPaneDropData
    target: Parameters<AppState['moveTabCluster']>[2]
    index: number
  }[])('routes a chip to $name and mirrors every member', ({ overData, target, index }) => {
    const { moveTabCluster, dropUnifiedTab, moveTabsInStrip, finishDrag } = commit(
      event(chip(), overData, 90)
    )
    expect(moveTabCluster.mock.calls).toEqual([['source', SOURCE_CLUSTER.id, target]])
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(moveTabsInStrip).not.toHaveBeenCalled()
    expect(vi.mocked(mirrorWebRuntimeTabMove).mock.calls.map(([move]) => move)).toEqual(
      SOURCE_CLUSTER.tabIds.map((tabId, offset) => ({
        kind: 'move-to-group',
        worktreeId: WT,
        tabId,
        targetGroupId: 'target',
        index: index + offset
      }))
    )
    expect(finishDrag.mock.calls).toEqual([[false, chip()]])
  })

  it.each([WT, FLOATING_TERMINAL_WORKTREE_ID])(
    'routes a local chip edge drop to a split in %s instead of a pane-body move',
    (worktreeId) => {
      seedDragPanes(worktreeId)
      const { moveTabCluster, dropUnifiedTab, moveTabsInStrip, finishDrag } = commit(
        event(
          { ...chip(), worktreeId },
          { kind: 'pane-body', worktreeId, groupId: 'source' },
          398,
          300
        ),
        paneGeometry('source'),
        worktreeId
      )
      expect(moveTabCluster.mock.calls).toEqual([
        ['source', SOURCE_CLUSTER.id, { groupId: 'source', splitDirection: 'right' }]
      ])
      expect(dropUnifiedTab).not.toHaveBeenCalled()
      expect(moveTabsInStrip).not.toHaveBeenCalled()
      expect(mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
      expect(finishDrag.mock.calls).toEqual([[false, undefined]])
      const groups = store.getState().groupsByWorktree[worktreeId]
      const splitGroup = groups.find((group) => group.id !== 'source' && group.id !== 'target')
      expect(groups).toHaveLength(3)
      expect(groups.find((group) => group.id === 'source')?.tabOrder).toEqual(['s-tail'])
      expect(splitGroup).toMatchObject({
        tabOrder: SOURCE_CLUSTER.tabIds,
        tabClusters: [SOURCE_CLUSTER]
      })
      expect(store.getState().layoutByWorktree[worktreeId]).toMatchObject({
        type: 'split',
        direction: 'horizontal',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'source' },
          second: { type: 'leaf', groupId: splitGroup?.id }
        },
        second: { type: 'leaf', groupId: 'target' }
      })
    }
  )

  it('cancels remote chip splits without falling through to a body move', () => {
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' })
    const { moveTabCluster, dropUnifiedTab, moveTabsInStrip, finishDrag } = commit(
      event(chip(), { kind: 'pane-body', worktreeId: WT, groupId: 'target' }, 398, 300),
      paneGeometry('target')
    )
    expect(moveTabCluster).not.toHaveBeenCalled()
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(moveTabsInStrip).not.toHaveBeenCalled()
    expect(finishDrag.mock.calls).toEqual([[true]])
    expect(mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })
})
