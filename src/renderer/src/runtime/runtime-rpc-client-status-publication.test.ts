import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCacheForTests,
  readCachedRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const runtimeEnvironmentCall = vi.fn()
const CAPABILITY = 'agent-session.host-authority.v1'

function runtimeStatus(capabilities: string[]): RuntimeStatus {
  return {
    runtimeId: 'remote-runtime',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities
  }
}

// The host status owner publishes a verified snapshot (its own copy) before settling the request.
function publishBeforeAnswering(capabilities: string[]): void {
  runtimeEnvironmentCall.mockImplementation(async () => {
    await Promise.resolve()
    clearRecentRuntimeCompatibilityFailure('env-published', runtimeStatus(capabilities))
    return {
      id: 'status',
      ok: true,
      result: runtimeStatus(capabilities),
      _meta: { runtimeId: 'remote-runtime' }
    }
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })
})

describe('a status publication that answers a pending probe (STA-11921)', () => {
  it('leaves the probed capability readable synchronously', async () => {
    publishBeforeAnswering([CAPABILITY])

    await expect(runtimeEnvironmentSupportsCapability('env-published', CAPABILITY)).resolves.toBe(
      true
    )

    expect(readCachedRuntimeEnvironmentCapability('env-published', CAPABILITY)).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })

  it('still re-probes after a missing capability so an in-place upgrade is seen', async () => {
    publishBeforeAnswering([])
    await expect(runtimeEnvironmentSupportsCapability('env-published', CAPABILITY)).resolves.toBe(
      false
    )

    publishBeforeAnswering([CAPABILITY])
    await expect(runtimeEnvironmentSupportsCapability('env-published', CAPABILITY)).resolves.toBe(
      true
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
  })
})
