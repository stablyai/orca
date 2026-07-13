import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
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
})
