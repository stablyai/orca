import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { buildOrchestrationTerminalGridRoot } from '../../../../shared/orchestration-terminal-grid'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'
import {
  detachTerminalPaneToTab,
  resolveTerminalTabStripDropTarget,
  type TerminalPaneTabDetachStore
} from './terminal-pane-tab-detach'

const WORKTREE_ID = 'repo-1::/worktree'
const SOURCE_TAB_ID = 'tab-source'
const TARGET_GROUP_ID = 'group-target'
const EXISTING_TAB_1 = 'tab-existing-1'
const EXISTING_TAB_2 = 'tab-existing-2'
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const GRID_LEAF_IDS = [
  LEAF_1,
  LEAF_2,
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777'
] as const

type LayoutGeometry = { width: number; height: number }

function measureLayoutGeometry(
  node: TerminalPaneLayoutNode,
  geometry: LayoutGeometry,
  result = new Map<string, LayoutGeometry>()
): Map<string, LayoutGeometry> {
  if (node.type === 'leaf') {
    result.set(node.leafId, geometry)
    return result
  }
  const ratio = node.ratio ?? 0.5
  measureLayoutGeometry(
    node.first,
    node.direction === 'vertical'
      ? { ...geometry, width: geometry.width * ratio }
      : { ...geometry, height: geometry.height * ratio },
    result
  )
  measureLayoutGeometry(
    node.second,
    node.direction === 'vertical'
      ? { ...geometry, width: geometry.width * (1 - ratio) }
      : { ...geometry, height: geometry.height * (1 - ratio) },
    result
  )
  return result
}

function rect(args: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    left: args.left,
    top: args.top,
    right: args.left + args.width,
    bottom: args.top + args.height,
    width: args.width,
    height: args.height
  } as DOMRect
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-left',
      [LEAF_2]: 'remote:env-1@@terminal-1'
    },
    buffersByLeafId: {
      [LEAF_2]: 'remote-buffer'
    },
    titlesByLeafId: {
      [LEAF_2]: 'remote shell'
    }
  }
}

function createTerminalTab(id: string, ptyId: string | null, shellOverride?: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Terminal 2',
    defaultTitle: 'Terminal 2',
    customTitle: null,
    color: null,
    sortOrder: 1,
    createdAt: 1,
    ...(shellOverride !== undefined ? { shellOverride } : {})
  }
}

function createStore(
  layout: TerminalLayoutSnapshot = splitLayout(),
  targetTabOrder: string[] = [EXISTING_TAB_1, EXISTING_TAB_2],
  sourceShellOverride = 'powershell.exe'
): TerminalPaneTabDetachStore {
  const store = {
    createTab: vi.fn((_worktreeId, _targetGroupId, _shellOverride, options) => {
      const tab = createTerminalTab('tab-detached', options?.initialPtyId ?? null)
      const group = store.groupsByWorktree[WORKTREE_ID]?.find(
        (candidate) => candidate.id === TARGET_GROUP_ID
      )
      if (group && !group.tabOrder.includes(tab.id)) {
        group.tabOrder = [...group.tabOrder, tab.id]
      }
      return tab
    }),
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TARGET_GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: targetTabOrder[0] ?? null,
          tabOrder: targetTabOrder,
          recentTabIds: []
        }
      ]
    },
    reorderUnifiedTabs: vi.fn((groupId: string, tabIds: string[]) => {
      const group = store.groupsByWorktree[WORKTREE_ID]?.find(
        (candidate) => candidate.id === groupId
      )
      if (group) {
        group.tabOrder = tabIds
      }
    }),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabLayout: vi.fn((tabId: string, nextLayout: TerminalLayoutSnapshot | null) => {
      if (nextLayout) {
        store.terminalLayoutsByTabId[tabId] = nextLayout
      } else {
        delete store.terminalLayoutsByTabId[tabId]
      }
    }),
    syncPaneDetachPtyOwnership: vi.fn(),
    tabsByWorktree: {
      [WORKTREE_ID]: [createTerminalTab(SOURCE_TAB_ID, 'pty-left', sourceShellOverride)]
    },
    terminalLayoutsByTabId: {
      [SOURCE_TAB_ID]: layout
    }
  }
  return store as unknown as TerminalPaneTabDetachStore
}

describe('resolveTerminalTabStripDropTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds a same-worktree tab strip under overlay elements', () => {
    const stripRect = rect({ left: 0, top: 0, width: 300, height: 32 })
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: WORKTREE_ID },
      getBoundingClientRect: () => stripRect,
      querySelectorAll: () => []
    }
    const overlay = { closest: () => null }
    const child = { closest: () => strip }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [overlay, child]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 10,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [{ id: TARGET_GROUP_ID } as AppState['groupsByWorktree'][string][number]]
        },
        worktreeId: WORKTREE_ID
      })
    ).toEqual({
      id: TARGET_GROUP_ID,
      groupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID,
      rect: stripRect
    })
  })

  it('resolves the insertion slot from the hovered tab side', () => {
    const stripRect = rect({ left: 0, top: 0, width: 300, height: 32 })
    const firstTabRect = rect({ left: 0, top: 0, width: 80, height: 32 })
    const secondTabRect = rect({ left: 80, top: 0, width: 80, height: 32 })
    const firstTab = {
      dataset: { tabId: EXISTING_TAB_1 },
      getBoundingClientRect: () => firstTabRect
    }
    const secondTab = {
      dataset: { tabId: EXISTING_TAB_2 },
      getBoundingClientRect: () => secondTabRect
    }
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: WORKTREE_ID },
      getBoundingClientRect: () => stripRect,
      querySelectorAll: () => [firstTab, secondTab]
    }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [{ closest: () => firstTab }, { closest: () => strip }]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 60,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: TARGET_GROUP_ID,
              activeTabId: EXISTING_TAB_1,
              tabOrder: [EXISTING_TAB_1, EXISTING_TAB_2],
              worktreeId: WORKTREE_ID
            } as AppState['groupsByWorktree'][string][number]
          ]
        },
        worktreeId: WORKTREE_ID
      })
    ).toMatchObject({
      groupId: TARGET_GROUP_ID,
      insertionIndex: 1,
      overlayKind: 'insertion',
      rect: rect({ left: 80, top: 0, width: 2, height: 32 })
    })
  })

  it('ignores strips from another worktree', () => {
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: 'other-worktree' },
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, right: 300, bottom: 32, width: 300, height: 32 }) as DOMRect
    }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [{ closest: () => strip }]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 10,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [{ id: TARGET_GROUP_ID } as AppState['groupsByWorktree'][string][number]]
        },
        worktreeId: WORKTREE_ID
      })
    ).toBeNull()
  })
})

describe('detachTerminalPaneToTab', () => {
  it('creates a new terminal tab with the detached leaf layout and PTY id', () => {
    const store = createStore()
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1)),
      detachPaneForExternalMove: vi.fn(() => true)
    }
    const persistLayoutSnapshot = vi.fn()

    const result = detachTerminalPaneToTab({
      manager,
      getStore: () => store,
      persistLayoutSnapshot,
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(result?.ptyId).toBe('remote:env-1@@terminal-1')
    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(2)
    expect(store.createTab).toHaveBeenCalledWith(WORKTREE_ID, TARGET_GROUP_ID, 'powershell.exe', {
      activate: true,
      initialPtyId: 'remote:env-1@@terminal-1',
      recordInteraction: true
    })
    expect(store.setTabLayout).toHaveBeenCalledWith(SOURCE_TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-left' }
    })
    expect(store.setTabLayout).toHaveBeenCalledWith('tab-detached', {
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
      buffersByLeafId: { [LEAF_2]: 'remote-buffer' },
      titlesByLeafId: { [LEAF_2]: 'remote shell' }
    })
    expect(store.syncPaneDetachPtyOwnership).toHaveBeenCalledWith({
      detachedLeafId: LEAF_2,
      detachedPtyId: 'remote:env-1@@terminal-1',
      sourceLayout: {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-left' }
      },
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: 'tab-detached'
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-detached')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(persistLayoutSnapshot).toHaveBeenCalled()
  })

  it.each(['powershell.exe', 'wsl.exe'])(
    'preserves the moved PTY shell override when the source uses %s',
    (shellOverride) => {
      const store = createStore(splitLayout(), [EXISTING_TAB_1], shellOverride)
      const manager = {
        getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
        getLeafId: vi.fn(() => LEAF_1),
        detachPaneForExternalMove: vi.fn(() => true)
      }

      detachTerminalPaneToTab({
        getStore: () => store,
        manager,
        persistLayoutSnapshot: vi.fn(),
        sourcePaneId: 1,
        sourceTabId: SOURCE_TAB_ID,
        targetGroupId: TARGET_GROUP_ID,
        worktreeId: WORKTREE_ID
      })

      expect(store.createTab).toHaveBeenCalledWith(
        WORKTREE_ID,
        TARGET_GROUP_ID,
        shellOverride,
        expect.objectContaining({ initialPtyId: 'pty-left' })
      )
    }
  )

  it('syncs PTY ownership when the primary source pane is detached', () => {
    const store = createStore()
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 1 ? LEAF_1 : LEAF_2)),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    const result = detachTerminalPaneToTab({
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 1,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(result?.ptyId).toBe('pty-left')
    expect(store.setTabLayout).toHaveBeenCalledWith(SOURCE_TAB_ID, {
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
      buffersByLeafId: { [LEAF_2]: 'remote-buffer' },
      titlesByLeafId: { [LEAF_2]: 'remote shell' }
    })
    expect(store.syncPaneDetachPtyOwnership).toHaveBeenCalledWith({
      detachedLeafId: LEAF_1,
      detachedPtyId: 'pty-left',
      sourceLayout: {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
        buffersByLeafId: { [LEAF_2]: 'remote-buffer' },
        titlesByLeafId: { [LEAF_2]: 'remote shell' }
      },
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: 'tab-detached'
    })
  })

  it('moves the detached tab into the requested group slot', () => {
    const store = createStore(splitLayout(), [EXISTING_TAB_1, EXISTING_TAB_2])
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1)),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    detachTerminalPaneToTab({
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      targetIndex: 1,
      worktreeId: WORKTREE_ID
    })

    expect(store.reorderUnifiedTabs).toHaveBeenCalledWith(
      TARGET_GROUP_ID,
      [EXISTING_TAB_1, 'tab-detached', EXISTING_TAB_2],
      { recordInteraction: false }
    )
  })

  it('uses the live transport PTY id when the snapshot has not persisted it yet', () => {
    const store = createStore({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null
    })
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn(() => LEAF_2),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    detachTerminalPaneToTab({
      fallbackPtyId: 'remote:env-2@@terminal-9',
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(store.setTabLayout).toHaveBeenCalledWith('tab-detached', {
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-2@@terminal-9' }
    })
  })

  it('keeps a detached null-PTY leaf eligible to finish its pending activation', () => {
    const store = createStore({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null
    })
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn(() => LEAF_2),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    const result = detachTerminalPaneToTab({
  it('commits canonical source geometry after detaching from a maintained grid', () => {
    const layout: TerminalLayoutSnapshot = {
      root: buildOrchestrationTerminalGridRoot(GRID_LEAF_IDS),
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      layoutMode: 'orchestration-grid',
      ptyIdsByLeafId: Object.fromEntries(
        GRID_LEAF_IDS.map((leafId, index) => [leafId, `pty-${index + 1}`])
      ),
      titlesByLeafId: Object.fromEntries(
        GRID_LEAF_IDS.map((leafId, index) => [leafId, `Worker ${index + 1}`])
      )
    }
    const store = createStore(layout)
    const manager = {
      getPanes: vi.fn(() => GRID_LEAF_IDS.map((_, index) => ({ id: index + 1 }))),
      getLeafId: vi.fn((paneId: number) => GRID_LEAF_IDS[paneId - 1] ?? null),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    detachTerminalPaneToTab({
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(result?.ptyId).toBeNull()
    expect(store.createTab).toHaveBeenCalledWith(WORKTREE_ID, TARGET_GROUP_ID, 'powershell.exe', {
      activate: true,
      pendingActivationSpawn: true,
      recordInteraction: true
    })
    const sourceLayout = store.terminalLayoutsByTabId[SOURCE_TAB_ID]!
    const geometry = measureLayoutGeometry(sourceLayout.root!, { width: 1, height: 1 })
    expect([...geometry.keys()]).toEqual(GRID_LEAF_IDS.filter((leafId) => leafId !== LEAF_2))
    for (const pane of geometry.values()) {
      expect(pane.width).toBeCloseTo(1 / 6)
      expect(pane.height).toBe(1)
    }
    expect(sourceLayout).toMatchObject({
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      layoutMode: 'orchestration-grid'
    })
    expect(sourceLayout.ptyIdsByLeafId).not.toHaveProperty(LEAF_2)
    expect(sourceLayout.titlesByLeafId).not.toHaveProperty(LEAF_2)
    expect(store.syncPaneDetachPtyOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLayout })
    )
  })
})
