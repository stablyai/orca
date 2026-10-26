import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildLayoutFrameSlices } from '../../store/workspace-layout-frame-slices'
import { buildLayoutFrameStorePatch } from '../../store/workspace-layout-frame-store-patch'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import { testContext } from '../../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { publishWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-published'
import { LEAF_1, LEAF_2, splitLayout } from './terminal-pane-tab-detach-fixture'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/server-layout-apply-routes'

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof sendLayoutCommandToOwner>(),
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({ ok: true, result: {} }))
}))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-owner-command', () => ({ sendLayoutCommandToOwner: mocks.send }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt'
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MOVED = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const GROUP = 'group-1'

function row(id: string, ptyId: string, createdAt: number) {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function entry(id: string, createdAt: number) {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal' as const,
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

/** The source tab split in two, and main's frame already showing the tab the pane moved into. */
function storeWithFrameDrawnMove() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt' })] },
    tabsByWorktree: { [WT]: [row(SOURCE, 'pty-left', 1), row(MOVED, 'pty-right', 2)] },
    unifiedTabsByWorktree: { [WT]: [entry(SOURCE, 1), entry(MOVED, 2)] },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          activeTabId: SOURCE,
          tabOrder: [SOURCE, MOVED],
          recentTabIds: [SOURCE]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        ...splitLayout(),
        ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' }
      },
      [MOVED]: {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-right' }
      }
    }
  })
  return store
}

/** The source tab alone, split in two, its second pane showing chat. */
function storeWithChatSplit() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt' })] },
    tabsByWorktree: { [WT]: [row(SOURCE, 'pty-left', 1)] },
    unifiedTabsByWorktree: { [WT]: [{ ...entry(SOURCE, 1), viewMode: 'chat' }] },
    groupsByWorktree: {
      [WT]: [
        { id: GROUP, worktreeId: WT, activeTabId: SOURCE, tabOrder: [SOURCE], recentTabIds: [] }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        ...splitLayout(),
        chatLeafId: LEAF_2,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' }
      }
    }
  })
  return store
}

/** The source tab split in two, its second pane not yet bound to a terminal. */
function storeWithUnboundSplit() {
  const store = storeWithChatSplit()
  const layout = store.getState().terminalLayoutsByTabId[SOURCE]!
  store.setState({
    unifiedTabsByWorktree: { [WT]: [entry(SOURCE, 1)] },
    terminalLayoutsByTabId: {
      [SOURCE]: { ...layout, chatLeafId: undefined, ptyIdsByLeafId: { [LEAF_1]: 'pty-left' } }
    }
  })
  return store
}

type MoveCommand = Parameters<typeof sendLayoutCommandToOwner>[1] & { type: 'movePaneToNewTab' }

/** Main applies the window's drag-out to its copy and the frame with the result is drawn. */
function drawMainMove(
  store: ReturnType<typeof createTestStore>,
  windowDetach: MoveCommand['windowDetach'] = { ptyId: 'pty-right' }
): void {
  const state = store.getState()
  const loaded = loadWorkspaceLayoutWithoutReport(
    'local',
    buildWorkspaceSessionPayload(state),
    nameBasedLoadContext()
  )
  const applied = applyLayoutCommand(
    loaded.layout,
    {
      type: 'movePaneToNewTab',
      workspace: WT,
      tabId: SOURCE,
      leafId: LEAF_2,
      groupId: GROUP,
      windowDetach: { ...windowDetach, tabId: MOVED }
    },
    testContext()
  )
  if (!applied.ok) {
    throw new Error(`main refused the move: ${applied.code}`)
  }
  const slices = buildLayoutFrameSlices({
    layouts: { [WT]: publishWorkspaceLayout(applied.model.workspaces[WT]!, 'local') },
    facts: loaded.facts,
    view: loaded.desktopView
  })
  store.setState(buildLayoutFrameStorePatch(state, slices, [WT]))
}

beforeEach(() => {
  mocks.send.mockReset()
  mocks.callRuntimeRpc.mockClear()
  vi.stubGlobal('window', { api: { pty: { moveLeafToNewTab: vi.fn() } } })
})

describe('a drag-out whose new tab main’s frame drew first', () => {
  it('shows the pane in the tab the frame drew instead of making a second one', async () => {
    const store = storeWithFrameDrawnMove()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      handlers.apply({ tabId: MOVED, ptyId: 'pty-right' }, LOCAL_LAYOUT_APPLY_ORIGIN)
      return true
    })

    const moved = await detachTerminalPaneToTab({
      getStore: () => store.getState(),
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE,
      targetGroupId: GROUP,
      worktreeId: WT
    })

    expect(moved).toMatchObject({ leafId: LEAF_2, ptyId: 'pty-right', tab: { id: MOVED } })
    const state = store.getState()
    expect(state.tabsByWorktree[WT]!.map((tab) => tab.id)).toEqual([SOURCE, MOVED])
    expect(state.terminalLayoutsByTabId[SOURCE]!.root).toEqual({ type: 'leaf', leafId: LEAF_1 })
    expect(state.terminalLayoutsByTabId[MOVED]!.root).toEqual({ type: 'leaf', leafId: LEAF_2 })
    expect(state.activeTabIdByWorktree[WT]).toBe(MOVED)
  })

  it('leaves the tab where main’s frame placed it, asked for an index', async () => {
    const store = storeWithFrameDrawnMove()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      handlers.apply({ tabId: MOVED, ptyId: 'pty-right' }, LOCAL_LAYOUT_APPLY_ORIGIN)
      return true
    })

    await detachTerminalPaneToTab({
      getStore: () => store.getState(),
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE,
      targetGroupId: GROUP,
      targetIndex: 0,
      worktreeId: WT
    })

    expect(store.getState().groupsByWorktree[WT]![0]!.tabOrder).toEqual([SOURCE, MOVED])
  })

  it('opens a dragged-out chat pane’s tab in chat view, as a window-owned build does', async () => {
    const store = storeWithChatSplit()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      drawMainMove(store)
      handlers.apply({ tabId: MOVED, ptyId: 'pty-right' }, LOCAL_LAYOUT_APPLY_ORIGIN)
      return true
    })

    await detachTerminalPaneToTab({
      getStore: () => store.getState(),
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE,
      targetGroupId: GROUP,
      worktreeId: WT
    })

    const moved = store.getState().unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === MOVED)
    expect(moved?.viewMode).toBe('chat')
    expect(store.getState().terminalLayoutsByTabId[MOVED]?.chatLeafId).toBe(LEAF_2)
  })

  it('starts an unbound pane’s new tab in the pane’s folder, as a window-owned build does', async () => {
    const store = storeWithUnboundSplit()
    mocks.send.mockImplementation((_worktreeId, command, handlers) => {
      drawMainMove(store, command.type === 'movePaneToNewTab' ? command.windowDetach : undefined)
      handlers.apply({ tabId: MOVED, ptyId: null }, LOCAL_LAYOUT_APPLY_ORIGIN)
      return true
    })

    await detachTerminalPaneToTab({
      getStore: () => store.getState(),
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneCwd: { cwd: '/path/wt/packages/app', confirmed: false },
      sourcePaneId: 2,
      sourceTabId: SOURCE,
      targetGroupId: GROUP,
      worktreeId: WT
    })

    const moved = store.getState().tabsByWorktree[WT]!.find((tab) => tab.id === MOVED)
    expect(moved).toMatchObject({ startupCwd: '/path/wt/packages/app' })
  })
})
