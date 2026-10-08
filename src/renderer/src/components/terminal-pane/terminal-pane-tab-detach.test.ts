import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import {
  detachTerminalPaneToTab,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import {
  createStore,
  EXISTING_TAB_1,
  EXISTING_TAB_2,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  splitLayout,
  TARGET_GROUP_ID,
  unboundSplitLayout,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'

const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
beforeEach(() => {
  toastErrorMock.mockClear()
  // No local main holds these sessions, so each move stays in the renderer.
  vi.stubGlobal('window', {
    api: { pty: { moveLeafToNewTab: () => Promise.resolve({ status: 'not_held' }) } }
  })
})

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

type SourcePaneCwd = NonNullable<Parameters<typeof detachTerminalPaneToTab>[0]['sourcePaneCwd']>

async function expectDeferredSplitDetachRejected(sourcePaneCwd: SourcePaneCwd): Promise<void> {
  const store = createStore(unboundSplitLayout())
  const manager = {
    getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
    getLeafId: vi.fn(() => LEAF_2),
    detachPaneForExternalMove: vi.fn(() => true)
  }
  const persistLayoutSnapshot = vi.fn()

  const result = await detachTerminalPaneToTab({
    getStore: () => store,
    manager,
    persistLayoutSnapshot,
    sourcePaneCwd,
    sourcePaneId: 2,
    sourceTabId: SOURCE_TAB_ID,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID
  })

  expect(result).toBeNull()
  expect(persistLayoutSnapshot).not.toHaveBeenCalled()
  expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
  expect(store.createTab).not.toHaveBeenCalled()
  expect(store.setTabLayout).not.toHaveBeenCalled()
  expect(store.syncPaneDetachPtyOwnership).not.toHaveBeenCalled()
  expect(store.setActiveTab).not.toHaveBeenCalled()
  expect(store.setActiveTabType).not.toHaveBeenCalled()
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
  it.each([LEAF_1, LEAF_2])('moves chat mode only with its owning leaf %s', async (chatLeafId) => {
    const store = createStore({ ...splitLayout(), chatLeafId })
    await detachTerminalPaneToTab({
      getStore: () => store,
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: () => LEAF_2,
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })
    const options = vi.mocked(store.createTab).mock.calls[0]?.[3]
    expect(options?.viewMode ?? 'terminal').toBe(chatLeafId === LEAF_2 ? 'chat' : 'terminal')
    expect(store.terminalLayoutsByTabId['tab-detached']?.chatLeafId).toBe(
      chatLeafId === LEAF_2 ? LEAF_2 : undefined
    )
    expect(store.terminalLayoutsByTabId[SOURCE_TAB_ID]?.chatLeafId).toBe(
      chatLeafId === LEAF_1 ? LEAF_1 : undefined
    )
  })

  it('creates a new terminal tab with the detached leaf layout and PTY id', async () => {
    const store = createStore()
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1)),
      detachPaneForExternalMove: vi.fn(() => true)
    }
    const persistLayoutSnapshot = vi.fn()

    const result = await detachTerminalPaneToTab({
      manager,
      getStore: () => store,
      persistLayoutSnapshot,
      sourcePaneCwd: {
        cwd: '/remote/repo',
        confirmed: false,
        deferredSplitSpawn: true,
        pendingCwd: Promise.resolve('/remote/repo/packages/app')
      },
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(result?.ptyId).toBe('remote:env-1@@terminal-1')
    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(2)
    expect(store.createTab).toHaveBeenCalledWith(WORKTREE_ID, TARGET_GROUP_ID, 'powershell.exe', {
      id: expect.any(String),
      activate: true,
      initialPtyId: 'remote:env-1@@terminal-1',
      initialLeafId: LEAF_2,
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
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal', WORKTREE_ID)
    expect(persistLayoutSnapshot).toHaveBeenCalled()
  })

  it.each(['powershell.exe', 'wsl.exe'])(
    'preserves the moved PTY shell override when the source uses %s',
    async (shellOverride) => {
      const store = createStore(splitLayout(), [EXISTING_TAB_1], shellOverride)
      const manager = {
        getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
        getLeafId: vi.fn(() => LEAF_1),
        detachPaneForExternalMove: vi.fn(() => true)
      }

      await detachTerminalPaneToTab({
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

  it('syncs PTY ownership when the primary source pane is detached', async () => {
    const store = createStore()
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 1 ? LEAF_1 : LEAF_2)),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    const result = await detachTerminalPaneToTab({
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

  it('moves the detached tab into the requested group slot', async () => {
    const store = createStore(splitLayout(), [EXISTING_TAB_1, EXISTING_TAB_2])
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn((paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1)),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    await detachTerminalPaneToTab({
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

  it('uses the live transport PTY id when the snapshot has not persisted it yet', async () => {
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

    await detachTerminalPaneToTab({
      livePtyId: 'remote:env-2@@terminal-9',
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneCwd: {
        cwd: '/remote/repo',
        confirmed: false,
        deferredSplitSpawn: true,
        pendingCwd: Promise.resolve('/remote/repo/packages/app')
      },
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

  it('rejects a deferred split while inherited cwd is pending', async () => {
    await expectDeferredSplitDetachRejected({
      cwd: '/remote/repo',
      deferredSplitSpawn: true,
      pendingCwd: new Promise<string>(() => {})
    })
  })

  it('rejects a pending cwd even when the deferred marker is absent', async () => {
    await expectDeferredSplitDetachRejected({
      cwd: '/remote/repo',
      pendingCwd: new Promise<string>(() => {})
    })
  })

  it('still rejects a deferred split after cwd resolves but before PTY bind', async () => {
    await expectDeferredSplitDetachRejected({
      cwd: '/remote/repo/packages/app',
      confirmed: false,
      deferredSplitSpawn: true
    })
  })

  it('carries resolved cwd when detaching an unbound non-deferred pane', async () => {
    const store = createStore(unboundSplitLayout())
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getLeafId: vi.fn(() => LEAF_2),
      detachPaneForExternalMove: vi.fn(() => true)
    }

    const result = await detachTerminalPaneToTab({
      getStore: () => store,
      manager,
      persistLayoutSnapshot: vi.fn(),
      sourcePaneCwd: {
        cwd: '/remote/repo/packages/app',
        confirmed: false
      },
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(result?.ptyId).toBeNull()
    expect(store.createTab).toHaveBeenCalledWith(WORKTREE_ID, TARGET_GROUP_ID, 'powershell.exe', {
      id: expect.any(String),
      activate: true,
      pendingActivationSpawn: true,
      recordInteraction: true,
      startupCwd: '/remote/repo/packages/app'
    })
  })
})
