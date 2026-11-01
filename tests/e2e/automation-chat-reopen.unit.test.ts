import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import type { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import type { RuntimeClientTarget } from '../../src/shared/runtime-client-target'

const bridge = vi.hoisted(() => {
  const current: {
    store: ReturnType<typeof createTestStore> | null
    call:
      | ((target: RuntimeClientTarget, method: string, params: unknown) => Promise<unknown>)
      | null
  } = { store: null, call: null }
  return { current, fallback: vi.fn(), workspace: vi.fn(() => true) }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!bridge.current.store) {
        throw new Error('renderer fixture not bound')
      }
      return bridge.current.store.getState()
    }
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (target: RuntimeClientTarget, method: string, params: unknown) => {
    if (!bridge.current.call) {
      throw new Error('transport fixture not bound')
    }
    return bridge.current.call(target, method, params)
  },
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: bridge.workspace,
  activateAndRevealFolderWorkspace: bridge.workspace
}))
vi.mock('sonner', () => ({ toast: { error: bridge.fallback, message: bridge.fallback } }))
vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

import { CHAT, SURVIVOR, createReopenRig } from './helpers/automation-chat-reopen-test-harness'
import { createTabsSliceMockApi } from '../../src/renderer/src/store/slices/tabs-slice-test-harness'
import { resetWebSessionTabsSyncTestState } from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/inventory-generation-fence'

createTabsSliceMockApi()
afterEach(() => {
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  bridge.current.store = null
  bridge.current.call = null
  vi.clearAllMocks()
})

it.each([false, true])(
  'Details republishes the same closed durable Chat through real owners, paired=%s',
  async (paired) => {
    const rig = await createReopenRig(paired, (store) => {
      bridge.current.store = store
    })
    bridge.current.call = rig.call
    try {
      await rig.close()
      expect(rig.selected()?.entityId).toBe(SURVIVOR)
      expect(
        rig.store
          .getState()
          .unifiedTabsByWorktree[rig.workspace]?.some((tab) => tab.entityId === CHAT)
      ).toBe(false)
      if (paired) {
        rig.decoy()
      }
      rig.action()
      await vi.waitFor(() =>
        expect(rig.calls.some(({ method }) => method === 'agentSession.reveal')).toBe(true)
      )
      await vi.waitFor(() =>
        expect(rig.selected()).toMatchObject({
          entityId: CHAT,
          executionHostId: paired ? 'runtime:reopen-host' : 'local'
        })
      )
      expect(rig.host.isSessionTabVisible(CHAT)).toBe(true)
      await rig.inventory()
      expect(rig.selected()?.entityId).toBe(CHAT)
      expect(bridge.fallback).not.toHaveBeenCalled()
      // A later real close wins; the next explicit click is a new, released interaction.
      await rig.close()
      await rig.inventory()
      expect(rig.selected()?.entityId).toBe(SURVIVOR)
      expect(rig.host.isSessionTabVisible(CHAT)).toBe(false)
      rig.action()
      await vi.waitFor(() =>
        expect(rig.calls.filter(({ method }) => method === 'agentSession.reveal')).toHaveLength(2)
      )
      await vi.waitFor(() =>
        expect(rig.selected()).toMatchObject({
          entityId: CHAT,
          executionHostId: paired ? 'runtime:reopen-host' : 'local'
        })
      )
      await rig.inventory()
      expect(rig.selected()?.entityId).toBe(CHAT)
      expect(bridge.fallback).not.toHaveBeenCalled()
      await rig.unchanged()
    } finally {
      rig.dispose()
    }
  }
)
