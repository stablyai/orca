// Exercise drag-out through main’s movePaneToNewTab and resulting frames, matching the window-side detach suites.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../../../../../shared/agent-status/title/agent-title-status'
import { buildWorkspaceSessionPayload } from '@/lib/workspace/persistence/workspace-session'
import { createStoreCascadesMockApi } from '../../../../store/testing/app-store-cascade-api.test-fixture'
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

vi.mock('../../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock(
  '../../../../../../shared/agent-status/title/agent-title-status',
  async (importOriginal) => {
    const actual = await importOriginal<typeof AgentStatusModule>()
    return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
  }
)

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
})
