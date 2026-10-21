// Layout-owner build: terminal-pane-tab-detach.test.ts's drag-out outcomes, reached through
// main's `movePaneToNewTab` and the frame that draws its result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { LEAF_1, LEAF_2, splitLayout, unboundSplitLayout } from './terminal-pane-tab-detach-fixture'
import {
  detachFrom,
  GROUP,
  mainMovedTabId,
  openMainFrames,
  OTHER_1,
  OTHER_2,
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

let closeFrames: () => void = () => {}
beforeEach(() => {
  createStoreCascadesMockApi()
})
afterEach(() => {
  closeFrames()
})

async function seeded(...args: Parameters<typeof seedDetachStore>): Promise<DetachStore> {
  const store = seedDetachStore(...args)
  closeFrames = await openMainFrames(store)
  return store
}

function movedRow(store: DetachStore) {
  return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === mainMovedTabId())
}

describe('detachTerminalPaneToTab, main moving the pane (layout-owner build)', () => {
  it.each([LEAF_1, LEAF_2])('moves chat mode only with its owning leaf %s', async (chatLeafId) => {
    const store = await seeded({ ...splitLayout(), chatLeafId })

    await detachFrom(store)

    const movedId = mainMovedTabId()
    const state = store.getState()
    const movedTab = state.unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === movedId)
    expect(movedTab?.viewMode ?? 'terminal').toBe(chatLeafId === LEAF_2 ? 'chat' : 'terminal')
    expect(state.terminalLayoutsByTabId[movedId]?.chatLeafId).toBe(
      chatLeafId === LEAF_2 ? LEAF_2 : undefined
    )
    expect(state.terminalLayoutsByTabId[SOURCE]?.chatLeafId).toBe(
      chatLeafId === LEAF_1 ? LEAF_1 : undefined
    )
  })

  it('shows main’s new terminal tab holding the moved pane and its terminal', async () => {
    const store = await seeded(splitLayout(), { shellOverride: 'powershell.exe', sshRepo: true })
    const manager = twoPaneManager()
    const persistLayoutSnapshot = vi.fn()

    const result = await detachFrom(store, {
      manager,
      persistLayoutSnapshot,
      sourcePaneCwd: {
        cwd: '/remote/repo',
        confirmed: false,
        deferredSplitSpawn: true,
        pendingCwd: Promise.resolve('/remote/repo/packages/app')
      }
    })

    expect(sentMove()).toMatchObject({
      workspace: WT,
      tabId: SOURCE,
      leafId: LEAF_2,
      groupId: GROUP,
      windowDetach: { ptyId: 'remote:env-1@@terminal-1' }
    })
    const movedId = mainMovedTabId()
    expect(result).toMatchObject({ tab: { id: movedId }, ptyId: 'remote:env-1@@terminal-1' })
    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(2)
    expect(movedRow(store)).toMatchObject({ shellOverride: 'powershell.exe' })
    const state = store.getState()
    expect(state.terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-left' }
    })
    expect(state.terminalLayoutsByTabId[movedId]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
      titlesByLeafId: { [LEAF_2]: 'remote shell' }
    })
    // The pane's scrollback is keyed by its leaf, so the moved tab saves it.
    const saved = buildWorkspaceSessionPayload(state).terminalLayoutsByTabId[movedId]
    expect(saved?.buffersByLeafId).toEqual({ [LEAF_2]: 'remote-buffer' })
    expect(state.ptyIdsByTabId[movedId]).toEqual(['remote:env-1@@terminal-1'])
    expect(state.ptyIdsByTabId[SOURCE]).toEqual(['pty-left'])
    expect(state.activeTabIdByWorktree[WT]).toBe(movedId)
    expect(state.activeTabTypeByWorktree[WT]).toBe('terminal')
    expect(persistLayoutSnapshot).toHaveBeenCalled()
  })

  it.each(['powershell.exe', 'wsl.exe'])(
    'preserves the moved PTY shell override when the source uses %s',
    async (shellOverride) => {
      const store = await seeded(splitLayout(), { shellOverride })

      await detachFrom(store, { sourcePaneId: 1 })

      expect(sentMove()).toMatchObject({ leafId: LEAF_1, windowDetach: { ptyId: 'pty-left' } })
      expect(movedRow(store)).toMatchObject({ shellOverride })
      expect(store.getState().ptyIdsByTabId[mainMovedTabId()]).toEqual(['pty-left'])
    }
  )

  it('syncs PTY ownership when the primary source pane is detached', async () => {
    const store = await seeded(splitLayout())

    const result = await detachFrom(store, { sourcePaneId: 1 })

    const movedId = mainMovedTabId()
    expect(result?.ptyId).toBe('pty-left')
    const state = store.getState()
    expect(state.terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
      titlesByLeafId: { [LEAF_2]: 'remote shell' }
    })
    expect(state.terminalLayoutsByTabId[movedId]?.root).toEqual({ type: 'leaf', leafId: LEAF_1 })
    expect(state.ptyIdsByTabId[SOURCE]).toEqual(['remote:env-1@@terminal-1'])
    expect(state.ptyIdsByTabId[movedId]).toEqual(['pty-left'])
  })

  it('moves the detached tab into the requested group slot', async () => {
    const store = await seeded(splitLayout())

    await detachFrom(store, { targetIndex: 1 })

    expect(sentMove()).toMatchObject({ groupId: GROUP, index: 1 })
    expect(store.getState().groupsByWorktree[WT]?.[0]?.tabOrder).toEqual([
      OTHER_1,
      mainMovedTabId(),
      OTHER_2,
      SOURCE
    ])
  })

  it('uses the live transport PTY id when the snapshot has not persisted it yet', async () => {
    const store = await seeded(unboundSplitLayout())

    await detachFrom(store, {
      livePtyId: 'remote:env-2@@terminal-9',
      sourcePaneCwd: {
        cwd: '/remote/repo',
        confirmed: false,
        deferredSplitSpawn: true,
        pendingCwd: Promise.resolve('/remote/repo/packages/app')
      }
    })

    expect(sentMove().windowDetach).toMatchObject({ ptyId: 'remote:env-2@@terminal-9' })
    expect(store.getState().terminalLayoutsByTabId[mainMovedTabId()]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-2@@terminal-9' }
    })
  })

  it('carries resolved cwd when detaching an unbound non-deferred pane', async () => {
    const store = await seeded(unboundSplitLayout(), { shellOverride: 'powershell.exe' })

    const result = await detachFrom(store, {
      sourcePaneCwd: { cwd: '/remote/repo/packages/app', confirmed: false }
    })

    expect(sentMove().windowDetach).toEqual({
      ptyId: null,
      startupCwd: '/remote/repo/packages/app'
    })
    expect(result?.ptyId).toBeNull()
    expect(movedRow(store)).toMatchObject({
      ptyId: null,
      shellOverride: 'powershell.exe',
      startupCwd: '/remote/repo/packages/app',
      pendingActivationSpawn: true
    })
    expect(store.getState().activeTabIdByWorktree[WT]).toBe(mainMovedTabId())
  })
})
