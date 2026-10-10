import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createStore,
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
const closeTerminalSurface = vi.fn(async () => {})
beforeEach(() => {
  toastErrorMock.mockClear()
  closeTerminalSurface.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** Answers each call with the next result; an Error throws. */
function mainAnswering(results: (TerminalLeafMoveResult | Error)[]) {
  return vi.fn((_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
    const next = results.shift() ?? { status: 'not_held' }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
}

function managerWithPanes(paneIds: () => number[] = () => [1, 2]) {
  return {
    getPanes: vi.fn(() => paneIds().map((id) => ({ id }))),
    getLeafId: vi.fn((paneId: number): string | null => (paneId === 2 ? LEAF_2 : LEAF_1)),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

type CommitMove = (request: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>

function detach(
  overrides: Partial<Parameters<typeof detachTerminalPaneToTab>[0]> & {
    commitMove?: CommitMove
    store?: ReturnType<typeof createStore>
  }
) {
  const { commitMove = mainAnswering([]), store = createStore(), ...rest } = overrides
  vi.stubGlobal('window', {
    api: { pty: { moveLeafToNewTab: commitMove }, session: { closeTerminalSurface } }
  })
  return detachTerminalPaneToTab({
    getStore: () => store,
    manager: managerWithPanes(),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId: SOURCE_TAB_ID,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID,
    ...rest
  })
}

const moved: TerminalLeafMoveResult = { status: 'moved', ptyId: 'remote:env-1@@terminal-1' }

describe('detachTerminalPaneToTab rolls a committed move forward', () => {
  it('refuses, silently, a pane whose PTY spawn is still in flight', async () => {
    const commitMove = mainAnswering([{ status: 'moved', ptyId: null }])
    const store = createStore(unboundSplitLayout())

    await expect(detach({ commitMove, store, sourceConnectPending: true })).resolves.toBeNull()

    expect(commitMove).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shows the failure toast and keeps the pane when main refuses or the commit throws', async () => {
    for (const results of [
      [{ status: 'refused', reason: 'pty_mismatch' } as const],
      [new Error('write failed')]
    ]) {
      toastErrorMock.mockClear()
      const store = createStore()
      const manager = managerWithPanes()

      await expect(
        detach({ commitMove: mainAnswering(results), store, manager })
      ).resolves.toBeNull()

      expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledOnce()
    }
  })

  it('closes main’s new tab, without a toast, when the user closed the pane meanwhile', async () => {
    let paneIds = [1, 2]
    const manager = managerWithPanes(() => paneIds)
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        paneIds = [1]
        manager.getLeafId.mockImplementation((paneId) => (paneId === 1 ? LEAF_1 : null))
        return moved
      }
    )
    const store = createStore()

    await expect(detach({ commitMove, manager, store })).resolves.toBeNull()

    const targetTabId = commitMove.mock.calls[0]?.[0]?.targetTabId
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: targetTabId },
      reason: 'cleanup'
    })
    expect(store.createTab).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('closes main’s new tab when the user closed the source tab meanwhile', async () => {
    const store = createStore()
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        // A tab close drops its row and its layout.
        store.tabsByWorktree[WORKTREE_ID] = []
        delete store.terminalLayoutsByTabId[SOURCE_TAB_ID]
        return moved
      }
    )

    await expect(detach({ commitMove, store })).resolves.toBeNull()

    expect(closeTerminalSurface).toHaveBeenCalledOnce()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('finds the pane by its leaf when its pane id changed meanwhile', async () => {
    const manager = managerWithPanes(() => [1, 7])
    manager.getLeafId.mockImplementation((paneId) => (paneId === 1 ? LEAF_1 : LEAF_2))
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        manager.getLeafId.mockImplementation((paneId) =>
          paneId === 1 ? LEAF_1 : paneId === 7 ? LEAF_2 : null
        )
        return moved
      }
    )

    await expect(detach({ commitMove, manager })).resolves.toMatchObject({ leafId: LEAF_2 })

    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(7)
  })

  it('closes main’s new tab when the pane manager refuses to detach the pane', async () => {
    const manager = managerWithPanes()
    manager.detachPaneForExternalMove.mockReturnValue(false)
    const commitMove = mainAnswering([moved])
    const store = createStore()

    await expect(detach({ commitMove, manager, store })).resolves.toBeNull()

    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: commitMove.mock.calls[0]?.[0]?.targetTabId },
      reason: 'cleanup'
    })
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setTabLayout).not.toHaveBeenCalled()
  })

  it('moves the last pane, after a sibling closed meanwhile, without killing its PTY', async () => {
    const store = createStore()
    let paneIds = [1, 2]
    const manager = managerWithPanes(() => paneIds)
    const commitMove = vi.fn(async (_request: TerminalLeafMoveRequest) => {
      // Closing a pane persists the layout synchronously (onLayoutChanged), as the real close does.
      paneIds = [2]
      store.terminalLayoutsByTabId[SOURCE_TAB_ID] = {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-right' }
      }
      return { status: 'moved', ptyId: 'pty-right' } satisfies TerminalLeafMoveResult
    })

    await expect(detach({ commitMove, manager, store })).resolves.toMatchObject({
      leafId: LEAF_2,
      ptyId: 'pty-right'
    })

    expect(closeTerminalSurface).not.toHaveBeenCalled()
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(store.syncPaneDetachPtyOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ detachedLeafId: LEAF_2, detachedPtyId: 'pty-right' })
    )
    expect(store.closeTab).toHaveBeenCalledWith(
      SOURCE_TAB_ID,
      expect.objectContaining({ localPtyTeardownOwnedExternally: true })
    )
  })

  it('commits the move in main before the target tab exists, using the same tab id', async () => {
    const store = createStore()
    let release!: () => void
    const commitMove = vi.fn(
      (_request: TerminalLeafMoveRequest) =>
        new Promise<TerminalLeafMoveResult>((resolve) => {
          release = () => resolve(moved)
        })
    )

    const detaching = detach({ commitMove, store })
    await vi.waitFor(() => expect(commitMove).toHaveBeenCalledOnce())
    expect(store.createTab).not.toHaveBeenCalled()
    release()
    await detaching

    const request = commitMove.mock.calls[0]?.[0]
    expect(request).toEqual({
      worktreeId: WORKTREE_ID,
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: expect.any(String),
      leafId: LEAF_2,
      ptyId: expect.any(String)
    })
    expect(store.createTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      TARGET_GROUP_ID,
      'powershell.exe',
      expect.objectContaining({ id: request?.targetTabId, initialLeafId: LEAF_2 })
    )
  })

  it('ignores a repeat drop of a pane whose move is still committing', async () => {
    const store = createStore()
    let release!: () => void
    const commitMove = vi.fn(
      (_request: TerminalLeafMoveRequest) =>
        new Promise<TerminalLeafMoveResult>((resolve) => {
          release = () => resolve(moved)
        })
    )

    const first = detach({ commitMove, store })
    await vi.waitFor(() => expect(commitMove).toHaveBeenCalledOnce())
    await expect(detach({ commitMove, store })).resolves.toBeNull()
    release()

    await expect(first).resolves.toMatchObject({ leafId: LEAF_2 })
    expect(commitMove).toHaveBeenCalledOnce()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('binds the moved tab’s layout to the live PTY, not the saved one', async () => {
    const store = createStore(splitLayout())
    const saved = store.terminalLayoutsByTabId[SOURCE_TAB_ID]?.ptyIdsByLeafId?.[LEAF_2]
    expect(saved).toBeTruthy()

    const result = await detach({ livePtyId: 'pty-respawned', store })

    expect(result?.ptyId).toBe('pty-respawned')
    expect(store.terminalLayoutsByTabId['tab-detached']?.ptyIdsByLeafId?.[LEAF_2]).toBe(
      'pty-respawned'
    )
  })
})
