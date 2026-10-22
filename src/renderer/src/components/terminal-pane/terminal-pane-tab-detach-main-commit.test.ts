// Layout-owner build: terminal-pane-tab-detach-commit.test.ts's roll-forward outcomes, with main's
// `movePaneToNewTab` answered (and its frame drawn) after what the user did meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type * as AgentStatusModule from '@/lib/agent-status'
import { layoutApplyTestTransport as main } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { LEAF_1, LEAF_2, splitLayout } from './terminal-pane-tab-detach-fixture'
import {
  detachFrom,
  GROUP,
  mainMovedTabId,
  openMainFrames,
  seedDetachStore,
  sentMove,
  SOURCE,
  twoPaneManager,
  WT,
  type DetachStore
} from './terminal-pane-tab-detach-main.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
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

const closeTerminalSurface = vi.fn(async (_args: unknown) => {})
const moveLeafToNewTab = vi.fn()
let api: ReturnType<typeof createStoreCascadesMockApi>
let closeFrames: () => void = () => {}
beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  closeTerminalSurface.mockClear()
  moveLeafToNewTab.mockClear()
  api = createStoreCascadesMockApi()
  Object.assign(api, { session: { closeTerminalSurface } })
  Object.assign(api.pty, { moveLeafToNewTab })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  closeFrames()
  // Main moved through layout.apply, never today's IPC.
  expect(moveLeafToNewTab).not.toHaveBeenCalled()
})

async function seeded(layout = splitLayout()): Promise<DetachStore> {
  const store = seedDetachStore(layout)
  closeFrames = await openMainFrames(store)
  return store
}

/** Holds main's answer to the move until `answer`, which applies it and draws its frame. */
async function moveHeldByMain<T>(detaching: () => Promise<T>) {
  main.answerWith('pending')
  const result = detaching()
  await vi.waitFor(() => expect(main.pendingCount).toBe(1))
  return {
    result,
    answer: async (): Promise<T> => {
      main.answerWith('apply')
      main.answerPending()
      await main.settle()
      return result
    }
  }
}

/** Every tab the window shows is one main's model holds: the window made none of its own. */
function expectOnlyMainTabs(store: DetachStore): void {
  const mainIds = main.mainModel?.workspaces[WT]?.tabs.map((tab) => tab.id) ?? []
  const shown = store.getState().tabsByWorktree[WT]?.map((tab) => tab.id) ?? []
  expect(shown.filter((id) => !mainIds.includes(id))).toEqual([])
}

function expectMainTabClosed(): void {
  expect(closeTerminalSurface).toHaveBeenCalledWith({
    worktreeId: WT,
    target: { kind: 'tab', tabId: mainMovedTabId() },
    reason: 'cleanup'
  })
}

describe('detachTerminalPaneToTab rolls main’s committed move forward (layout-owner build)', () => {
  it('closes main’s new tab, without a toast, when the user closed the pane meanwhile', async () => {
    const store = await seeded()
    let paneIds = [1, 2]
    const manager = twoPaneManager()
    manager.getPanes.mockImplementation(() => paneIds.map((id) => ({ id })))
    const move = await moveHeldByMain(() => detachFrom(store, { manager }))
    paneIds = [1]
    manager.getLeafId.mockImplementation((paneId) => (paneId === 1 ? LEAF_1 : null))

    await expect(move.answer()).resolves.toBeNull()

    expectMainTabClosed()
    expectOnlyMainTabs(store)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('closes main’s new tab when the user closed the source tab meanwhile', async () => {
    const store = await seeded()
    const move = await moveHeldByMain(() => detachFrom(store))
    // A tab close drops its row and its layout.
    store.setState((state) => {
      const { [SOURCE]: _closed, ...terminalLayoutsByTabId } = state.terminalLayoutsByTabId
      return {
        tabsByWorktree: {
          [WT]: (state.tabsByWorktree[WT] ?? []).filter((tab) => tab.id !== SOURCE)
        },
        terminalLayoutsByTabId
      }
    })

    await expect(move.answer()).resolves.toBeNull()

    expect(closeTerminalSurface).toHaveBeenCalledOnce()
    expectMainTabClosed()
    expectOnlyMainTabs(store)
  })

  it('finds the pane by its leaf when its pane id changed meanwhile', async () => {
    const store = await seeded()
    const manager = twoPaneManager()
    const move = await moveHeldByMain(() => detachFrom(store, { manager }))
    manager.getPanes.mockImplementation(() => [{ id: 1 }, { id: 7 }])
    manager.getLeafId.mockImplementation((paneId) =>
      paneId === 1 ? LEAF_1 : paneId === 7 ? LEAF_2 : null
    )

    await expect(move.answer()).resolves.toMatchObject({ leafId: LEAF_2 })

    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(7)
  })

  it('closes main’s new tab when the pane manager refuses to detach the pane', async () => {
    const store = await seeded()
    const manager = twoPaneManager()
    manager.detachPaneForExternalMove.mockReturnValue(false)

    await expect(detachFrom(store, { manager })).resolves.toBeNull()

    expectMainTabClosed()
    expectOnlyMainTabs(store)
  })

  it('moves the last pane, after a sibling closed meanwhile, without killing its PTY', async () => {
    const store = await seeded({
      ...splitLayout(),
      ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' }
    })
    let paneIds = [1, 2]
    const manager = twoPaneManager()
    manager.getPanes.mockImplementation(() => paneIds.map((id) => ({ id })))
    const move = await moveHeldByMain(() => detachFrom(store, { manager }))
    // Closing a pane persists the layout synchronously (onLayoutChanged), as the real close does.
    paneIds = [2]
    store.getState().setTabLayout(SOURCE, {
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-right' }
    })

    await expect(move.answer()).resolves.toMatchObject({ leafId: LEAF_2, ptyId: 'pty-right' })

    const movedId = mainMovedTabId()
    expect(closeTerminalSurface).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'tab', tabId: movedId } })
    )
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expectOnlyMainTabs(store)
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.some((tab) => tab.id === SOURCE)).toBe(false)
    expect(state.terminalLayoutsByTabId[movedId]?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'pty-right'
    })
    expect(state.ptyIdsByTabId[movedId]).toEqual(['pty-right'])
    expect(api.pty.kill).not.toHaveBeenCalledWith('pty-right', expect.anything())
    expect(api.pty.kill).not.toHaveBeenCalledWith('pty-right')
  })

  it('commits the move in main before the target tab exists, then shows main’s tab', async () => {
    const store = await seeded()
    const tabsBefore = store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)
    const move = await moveHeldByMain(() => detachFrom(store))

    expect(sentMove()).toEqual({
      type: 'movePaneToNewTab',
      workspace: WT,
      tabId: SOURCE,
      leafId: LEAF_2,
      groupId: GROUP,
      windowDetach: { ptyId: 'remote:env-1@@terminal-1' }
    })
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(tabsBefore)

    const result = await move.answer()
    const movedId = mainMovedTabId()
    expect(result?.tab.id).toBe(movedId)
    expect(store.getState().terminalLayoutsByTabId[movedId]?.root).toEqual({
      type: 'leaf',
      leafId: LEAF_2
    })
  })

  it('ignores a repeat drop of a pane whose move is still committing', async () => {
    const store = await seeded()
    const move = await moveHeldByMain(() => detachFrom(store))

    await expect(detachFrom(store)).resolves.toBeNull()

    await expect(move.answer()).resolves.toMatchObject({ leafId: LEAF_2 })
    expect(main.sentOfType('movePaneToNewTab')).toHaveLength(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('binds the moved tab’s layout to the live PTY, not the saved one', async () => {
    const store = await seeded()
    const saved = store.getState().terminalLayoutsByTabId[SOURCE]?.ptyIdsByLeafId?.[LEAF_2]
    expect(saved).toBeTruthy()

    const result = await detachFrom(store, { livePtyId: 'pty-respawned' })

    expect(sentMove().windowDetach).toEqual({ ptyId: 'pty-respawned' })
    expect(result?.ptyId).toBe('pty-respawned')
    expect(store.getState().terminalLayoutsByTabId[mainMovedTabId()]?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: 'pty-respawned'
    })
  })
})
