import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeDetectedAgentsTestStore as createTestStore } from './runtime-detected-agents.test-fixture'

import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { stubRuntimeEnvironmentBridge } from '../../runtime/rpc/testing/runtime-environment-bridge-fixture'

const runtimeEnvironmentCall = vi.fn()

stubRuntimeEnvironmentBridge({ call: runtimeEnvironmentCall })

type ServedHostStatus = { hostPlatform?: NodeJS.Platform; scoped: boolean }

function serveHost(host: ServedHostStatus): void {
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'remote-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: host.scoped ? [PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY] : [],
            ...(host.hostPlatform ? { hostPlatform: host.hostPlatform } : {})
          }
        : method === 'preflight.refreshAgents'
          ? { agents: ['codex'] }
          : ['codex']
    return Promise.resolve({ id: method, ok: true, result, _meta: { runtimeId: 'remote-runtime' } })
  })
}

function agentCalls(): unknown[] {
  return runtimeEnvironmentCall.mock.calls
    .map(([request]) => request)
    .filter((request: { method: string }) => request.method !== 'status.get')
}

const KEY = getRuntimeAgentInventoryKey('env-1', 'wt-1')

describe('workspace agent detection on a host without workspace-scoped detection', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
  })

  it('clears the notice once the host is updated', async () => {
    serveHost({ hostPlatform: 'win32', scoped: false })
    const store = createTestStore()
    await store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')

    serveHost({ hostPlatform: 'win32', scoped: true })
    await expect(store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')).resolves.toEqual([
      'codex'
    ])

    expect(agentCalls()).toEqual([
      expect.objectContaining({ method: 'preflight.detectAgents', params: { worktreeId: 'wt-1' } })
    ])
    expect(store.getState().runtimeDetectedAgentIds[KEY]).toEqual(['codex'])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[KEY]).toBeUndefined()
  })
})
