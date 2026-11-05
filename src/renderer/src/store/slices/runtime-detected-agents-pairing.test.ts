import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(), status: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports,
  getRuntimeEnvironmentStatus: rpc.status
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal API stub for the store under test
globalThis.window = { api: {} }
import { createRuntimeDetectedAgentsPairingTestStore as createTestStore } from './runtime-detected-agents-pairing.test-fixture'
import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'

function environment(pairingRevision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'detection-peer',
    name: 'Paired host',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: 'host'
  }
}

const WORKTREE = 'repo::/workspace'
const WORKSPACE_KEY = getRuntimeAgentInventoryKey('detection-peer', WORKTREE)

beforeEach(() => {
  rpc.call.mockReset()
  rpc.supports.mockReset()
  rpc.status.mockReset()
  createTestStore().getState().clearRuntimeDetectedAgents('detection-peer')
})

describe('runtime detection across a re-pair', () => {
  it('sends a workspace probe whose capability check straddles a re-pair fenced to the retired pairing', async () => {
    const store = createTestStore()
    let answerCapability!: (supported: boolean) => void
    rpc.supports.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        answerCapability = resolve
      })
    )
    rpc.call.mockResolvedValue(['claude'])
    store.getState().setRuntimeEnvironments([environment(1)])
    const old = store.getState().ensureRuntimeDetectedAgents('detection-peer', WORKTREE)
    store.getState().setRuntimeEnvironments([environment(2)])
    answerCapability(true)
    await old
    expect(rpc.call).toHaveBeenCalledTimes(1)
    expect(rpc.call.mock.calls[0]?.[3]).toEqual({ expectedEnvironmentPairingRevision: 1 })
    expect(store.getState().runtimeDetectedAgentIds[WORKSPACE_KEY]).toBeUndefined()
  })
})
