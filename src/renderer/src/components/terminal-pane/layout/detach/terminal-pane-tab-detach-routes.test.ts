// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
  | {
      kind: 'host'
      authority: {
        environmentId: string
        pairingRevision: number
        runtimeId: string
        worktreeId: string
      }
    }
  | { kind: 'window' }
  | { kind: 'unavailable' }
type HostMoveState = {
  route: HostRoute
  outcome: 'moved' | 'refused' | 'unknown'
  settle: ReturnType<typeof vi.fn>
  move: ReturnType<typeof vi.fn>
  currentPairing: boolean
  onResolve?: () => void
}

const hostMove = vi.hoisted((): HostMoveState => ({
  route: { kind: 'window' },
  outcome: 'moved',
  settle: vi.fn(),
  move: vi.fn(),
  currentPairing: true
}))
const HOST_ROUTE = {
  kind: 'host',
  authority: {
    environmentId: 'env-1',
    pairingRevision: 1,
    runtimeId: 'runtime-1',
    worktreeId: 'repo-1::/worktree'
  }
} as const

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/hosted-terminals/actions/web-runtime-leaf-move', () => ({
  resolvePaneMoveHost: vi.fn(async () => {
    hostMove.onResolve?.()
    return hostMove.route
  }),
  moveWebRuntimeLeafToNewTab: hostMove.move,
  settleHostPaneMove: hostMove.settle,
  isCurrentPaneMoveHost: () => hostMove.currentPairing
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

type FakeManager = {
  getPanes: () => { id: number }[]
  getLeafId: (paneId: number) => string | null
  detachPaneForExternalMove: Mock<(paneId: number) => boolean>
}

/** A pane manager for the source tab; a remount builds a new one with new pane ids. */
function manager(paneIdOfLeaf2 = 2): FakeManager {
  const panes = [{ id: 1 }, { id: paneIdOfLeaf2 }]
  return {
    getPanes: () => panes,
    getLeafId: (paneId: number) =>
      paneId === 1 ? LEAF_1 : paneId === paneIdOfLeaf2 ? LEAF_2 : null,
    detachPaneForExternalMove: vi.fn<(paneId: number) => boolean>(() => true)
  }
}

function storeFor(sourceTabId: string, layout: TerminalLayoutSnapshot): TerminalPaneTabDetachStore {
  const store = createStore(layout)
  store.terminalLayoutsByTabId[sourceTabId] = layout
  store.activeTabId = sourceTabId
  return store
}

/** What the tab's refs hold now: its manager and each pane's live PTY. */
type SourceTab = { manager: FakeManager; livePtyId: string }

function detach(
  store: TerminalPaneTabDetachStore,
  sourceTabId: string,
  extra: Partial<
    Pick<
      Parameters<typeof detachTerminalPaneToTab>[0],
      'targetTabId' | 'targetIndex' | 'afterTabId'
    >
  > = {},
  source: SourceTab = { manager: manager(), livePtyId: 'pty-right' }
) {
  return detachTerminalPaneToTab({
    getStore: () => store,
    getManager: () => source.manager,
    readPane: (paneId) => ({
      livePtyId: paneId === 1 ? 'pty-left' : source.livePtyId,
      connectPending: false
    }),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID,
    ...extra
  })
}

function unifiedRows(rows: { id: string; groupId: string; isPinned?: boolean }[]) {
  return rows.map((row) => ({
    entityId: row.id,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal' as const,
    label: row.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    ...row
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  hostMove.route = { kind: 'window' }
  hostMove.outcome = 'moved'
  hostMove.currentPairing = true
  hostMove.onResolve = undefined
  hostMove.move.mockImplementation(async () => hostMove.outcome)
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
    expect(store.setTabCustomTitle).toHaveBeenCalledWith(moved?.tab.id, 'build-watch', {
      recordInteraction: false
    })
  })

  it('names the tab it draws for another client too, as the committer', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    await detach(store, SOURCE_TAB_ID, { targetTabId: 'tab-detached' })

    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-detached', 'build-watch', {
      recordInteraction: false
    })
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
    expect(store.terminalLayoutsByTabId[moved!.tab.id]?.ptyIdsByLeafId).toEqual({
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
    hostMove.route = HOST_ROUTE
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

  it('leaves naming a host tab to the host, which names it in its commit', async () => {
    hostMove.route = HOST_ROUTE
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    await detach(store, HOST_SOURCE_TAB_ID)
    await vi.waitFor(() => expect(hostMove.settle).toHaveBeenCalled())

    expect(store.setTabCustomTitle).not.toHaveBeenCalled()
  })

  it('carries the PTY the pane is bound to when the move is sent, not when it was asked for', async () => {
    hostMove.route = HOST_ROUTE
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())
    const source = { manager: manager(), livePtyId: 'pty-right' }
    hostMove.onResolve = () => {
      source.livePtyId = 'pty-rebound'
    }

    await detach(store, HOST_SOURCE_TAB_ID, {}, source)

    expect(hostMove.move.mock.calls[0]?.[1]).toMatchObject({ ptyId: 'pty-rebound' })
  })

  it('sends nothing when the host was re-paired while the move was being prepared', async () => {
    hostMove.route = HOST_ROUTE
    hostMove.currentPairing = false
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)

    expect(moved).toBeNull()
    expect(hostMove.move).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('does not follow the pane when the user switched to a browser tab meanwhile', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      // The terminal id stays set while a browser tab is shown.
      store.activeTabType = 'browser'
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.followed).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('keeps a tab pinned while the move was in flight ahead of the new one', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    store.unifiedTabsByWorktree[WORKTREE_ID] = ['tab-existing-1', 'tab-existing-2'].map((id) => ({
      id,
      entityId: id,
      groupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID,
      contentType: 'terminal' as const,
      label: id,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: id === 'tab-existing-1'
    }))
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      store.unifiedTabsByWorktree[WORKTREE_ID]![1]!.isPinned = true
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID, { targetIndex: 1 })

    expect(store.groupsByWorktree[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'tab-existing-1',
      'tab-existing-2',
      moved?.tab.id
    ])
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

    const moved = await detach(store, SOURCE_TAB_ID, { targetIndex: 0 })

    expect(store.groupsByWorktree[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'tab-existing-1',
      moved?.tab.id,
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
  it('does not follow the pane behind Settings opened while main was answering', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      // Settings covers the terminal view; the terminal tab id stays set.
      store.activeView = 'settings'
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.followed).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('detaches the pane from the manager the tab has when main answers', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    const before = manager()
    const source = { manager: before, livePtyId: 'pty-right' }
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      // The tab remounted while main committed: a new manager, the leaf under a new pane id.
      source.manager = manager(7)
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID, {}, source)

    expect(moved?.leafId).toBe(LEAF_2)
    expect(before.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(source.manager.detachPaneForExternalMove).toHaveBeenCalledWith(7)
  })

  it('moves a pane main does not hold with the PTY it is bound to after the reply', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    const source = { manager: manager(), livePtyId: 'pty-right' }
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      source.livePtyId = 'pty-rebound'
      return { status: 'not_held' }
    })

    const moved = await detach(store, SOURCE_TAB_ID, {}, source)

    expect(moved?.ptyId).toBe('pty-rebound')
    expect(store.terminalLayoutsByTabId[moved!.tab.id]?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'pty-rebound'
    })
  })

  it('leaves the pane in place when its destination group closed before the window could move it', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    const source = { manager: manager(), livePtyId: 'pty-right' }
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      store.groupsByWorktree[WORKTREE_ID] = []
      return { status: 'not_held' }
    })

    const moved = await detach(store, SOURCE_TAB_ID, {}, source)

    expect(moved).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(source.manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('puts a move main committed beside its source when the destination group closed meanwhile', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    store.groupsByWorktree[WORKTREE_ID]!.push({
      id: 'group-source',
      worktreeId: WORKTREE_ID,
      activeTabId: 'row-source',
      tabOrder: ['row-source', 'row-other'],
      recentTabIds: []
    })
    store.unifiedTabsByWorktree[WORKTREE_ID] = unifiedRows([
      { id: 'row-source', groupId: 'group-source' },
      { id: 'row-other', groupId: 'group-source' }
    ]).map((row) => (row.id === 'row-source' ? { ...row, entityId: SOURCE_TAB_ID } : row))
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      store.groupsByWorktree[WORKTREE_ID] = store.groupsByWorktree[WORKTREE_ID]!.filter(
        (group) => group.id !== TARGET_GROUP_ID
      )
      return { status: 'moved', ptyId: 'pty-right' }
    })

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(store.createTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      'group-source',
      undefined,
      expect.anything()
    )
    expect(store.groupsByWorktree[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'row-source',
      moved?.tab.id,
      'row-other'
    ])
  })

  it('lands a menu move right after its source even if the source was reordered meanwhile', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())
    vi.mocked(window.api.pty.moveLeafToNewTab).mockImplementationOnce(async () => {
      // The source row was dragged to the end of its group while main committed.
      store.groupsByWorktree[WORKTREE_ID]![0]!.tabOrder = ['tab-existing-2', 'tab-existing-1']
      return { status: 'moved', ptyId: 'pty-right' }
    })

    // Asked for as "after tab-existing-2", which was then at index 1.
    const moved = await detach(store, SOURCE_TAB_ID, {
      targetIndex: 2,
      afterTabId: 'tab-existing-2'
    })

    expect(store.groupsByWorktree[WORKTREE_ID]?.[0]?.tabOrder).toEqual([
      'tab-existing-2',
      moved?.tab.id,
      'tab-existing-1'
    ])
  })
  it('does not move a pane that is still starting, so a late spawn cannot land in its old tab', async () => {
    const layout = titledLayout()
    const store = storeFor(SOURCE_TAB_ID, { ...layout, ptyIdsByLeafId: { [LEAF_1]: 'pty-left' } })

    const moved = await detachTerminalPaneToTab({
      getStore: () => store,
      getManager: () => manager(),
      readPane: (paneId) =>
        paneId === 1
          ? { livePtyId: 'pty-left', connectPending: false }
          : { livePtyId: null, connectPending: true },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })

    expect(moved).toBeNull()
    expect(window.api.pty.moveLeafToNewTab).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
  })
})
