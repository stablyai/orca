import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type * as RuntimeCompatibilityProbeModule from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(), status: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: rpc.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (original) => ({
  ...(await original<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: rpc.supports
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', async (original) => ({
  ...(await original<typeof RuntimeCompatibilityProbeModule>()),
  getRuntimeEnvironmentStatus: rpc.status
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
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
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'detection-peer' },
      'preflight.detectAgents',
      { worktreeId: 'repo::/workspace' },
      { expectedEnvironmentPairingRevision: 1 }
    )
    expect(store.getState().runtimeDetectedAgentIds[WORKSPACE_KEY]).toBeUndefined()
  })
})
