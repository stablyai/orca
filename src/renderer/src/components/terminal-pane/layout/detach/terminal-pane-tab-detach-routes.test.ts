// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { toWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import {
  createStore,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'
import type { TerminalPaneTabDetachStore } from './terminal-pane-tab-detach-steps'
import type { TerminalLeafMoveResult } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'

type HostRoute =
  | { kind: 'host'; environmentId: string }
  | { kind: 'window' }
  | { kind: 'unavailable' }
type HostMoveState = {
  route: HostRoute
  outcome: 'moved' | 'refused' | 'unknown'
  settle: ReturnType<typeof vi.fn>
}

const hostMove = vi.hoisted((): HostMoveState => ({
  route: { kind: 'window' },
  outcome: 'moved',
  settle: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/hosted-terminals/actions/web-runtime-leaf-move', () => ({
  resolvePaneMoveHost: vi.fn(async () => hostMove.route),
  moveWebRuntimeLeafToNewTab: vi.fn(async () => hostMove.outcome),
  settleHostPaneMove: hostMove.settle
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move', () => ({
  resolveHostTabDropTarget: vi.fn(async (_env: string, args: { targetGroupId: string }) => ({
    targetGroupId: args.targetGroupId
  }))
}))
// Only reached with the main layout owner on, which these tests leave off; its graph is heavy.
vi.mock('./terminal-pane-detach-layout-owner', () => ({ moveLeafThroughLayoutOwner: vi.fn() }))
vi.mock('@/store/terminals/retirement/terminal-surface-close-intent', () => ({
  commitTerminalSurfaceClose: vi.fn()
}))

const { detachTerminalPaneToTab } = await import('./terminal-pane-tab-detach')

const HOST_SOURCE_TAB_ID = toWebTerminalSurfaceTabId('host-tab::host-leaf')

function titledLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' },
    titlesByLeafId: { [LEAF_2]: 'build-watch' }
  }
}

function manager() {
  const panes = [{ id: 1 }, { id: 2 }]
  return {
    getPanes: () => panes,
    getLeafId: (paneId: number) => (paneId === 1 ? LEAF_1 : paneId === 2 ? LEAF_2 : null),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

function storeFor(sourceTabId: string, layout: TerminalLayoutSnapshot): TerminalPaneTabDetachStore {
  const store = createStore(layout)
  store.terminalLayoutsByTabId[sourceTabId] = layout
  store.activeTabId = sourceTabId
  return store
}

function detach(
  store: TerminalPaneTabDetachStore,
  sourceTabId: string,
  extra: { targetTabId?: string; targetIndex?: number } = {}
) {
  return detachTerminalPaneToTab({
    livePtyId: 'pty-right',
    getStore: () => store,
    manager: manager(),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID,
    ...extra
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hostMove.route = { kind: 'window' }
  hostMove.outcome = 'moved'
  Object.assign(window, {
    api: {
      pty: {
        moveLeafToNewTab: vi.fn(async () => ({ status: 'moved', ptyId: 'pty-right' }))
      }
    }
  })
})

describe('moving a pane to a new tab', () => {
  it('names the new tab after the pane it carries', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.ptyId).toBe('pty-right')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-detached', 'build-watch', {
      recordInteraction: false
    })
  })

  it('leaves naming to the client that asked for the move', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    await detach(store, SOURCE_TAB_ID, { targetTabId: 'tab-detached' })

    expect(store.setTabCustomTitle).not.toHaveBeenCalled()
  })

  const mainAnswers: [string, () => Promise<TerminalLeafMoveResult>][] = [
    ['main refuses', async () => ({ status: 'refused', reason: 'pane_unavailable' })],
    [
      'main does not answer',
      async () => {
        throw new Error('ipc gone')
      }
    ]
  ]
  it.each(mainAnswers)(
    'leaves the pane in place and tells the user when %s',
    async (_case, answer) => {
      vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(answer)
      const store = storeFor(SOURCE_TAB_ID, titledLayout())

      const moved = await detach(store, SOURCE_TAB_ID)

      expect(moved).toBeNull()
      expect(store.createTab).not.toHaveBeenCalled()
      expect(store.setTabLayout).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledTimes(1)
    }
  )

  it('moves the pane in this window when main does not hold the tab', async () => {
    vi.mocked(window.api.pty.moveLeafToNewTab).mockResolvedValueOnce({ status: 'not_held' })
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.ptyId).toBe('pty-right')
    expect(store.terminalLayoutsByTabId['tab-detached']?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'pty-right'
    })
  })

  it('refuses up front when the host owning the tab cannot take the move', async () => {
    hostMove.route = { kind: 'unavailable' }
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)

    expect(moved).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(window.api.pty.moveLeafToNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('tells the user when the host refuses a move it already drew', async () => {
    hostMove.route = { kind: 'host', environmentId: 'env-1' }
    hostMove.outcome = 'refused'
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)
    await vi.waitFor(() => expect(hostMove.settle).toHaveBeenCalled())

    expect(moved).not.toBeNull()
    const [, , outcome, movedHere, hooks] = hostMove.settle.mock.calls[0]
    expect([outcome, movedHere]).toEqual(['refused', true])
    hooks.onRefused()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('names a host tab only once the host commits the move', async () => {
    hostMove.route = { kind: 'host', environmentId: 'env-1' }
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)
    await vi.waitFor(() => expect(hostMove.settle).toHaveBeenCalled())

    expect(store.setTabCustomTitle).not.toHaveBeenCalled()
    hostMove.settle.mock.calls[0][4].onCommitted()
    expect(store.setTabCustomTitle).toHaveBeenCalledWith(moved?.tab.id, 'build-watch', {
      recordInteraction: false
    })
  })

  it('places the new tab after the pinned tabs, since it is never pinned', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    store.unifiedTabsByWorktree[WORKTREE_ID] = [
      { id: 'tab-existing-1', isPinned: true },
      { id: 'tab-existing-2', isPinned: false }
    ].map((tab) => ({
      ...tab,
      entityId: tab.id,
      groupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal' as const,
      label: tab.id,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }))

    await detach(store, SOURCE_TAB_ID, { targetIndex: 0 })

    expect(store.groupsByWorktree[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'tab-existing-1',
      'tab-detached',
      'tab-existing-2'
    ])
  })

  it('does not pull the user to the new tab when they moved on before the move landed', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      store.activeTabId = 'tab-existing-2'
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.followed).toBe(false)
    expect(store.createTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      TARGET_GROUP_ID,
      undefined,
      expect.objectContaining({ activate: false })
    )
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })
})
