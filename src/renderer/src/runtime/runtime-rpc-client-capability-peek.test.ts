import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRuntimeCompatibilityCacheForTests,
  peekRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const CAPABILITY = 'session.terminal-scrollback-read.v1'
const runtimeEnvironmentCall = vi.fn()

function statusReply(capabilities: string[]) {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'remote-runtime',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities
    },
    _meta: { runtimeId: 'remote-runtime' }
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeEnvironmentCall, subscribe: vi.fn() } }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('peekRuntimeEnvironmentCapability', () => {
  it('answers undefined without issuing a request when no status is cached', () => {
    expect(peekRuntimeEnvironmentCapability('env-cold', CAPABILITY)).toBeUndefined()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('answers a cached positive verdict synchronously', async () => {
    runtimeEnvironmentCall.mockResolvedValue(statusReply([CAPABILITY]))
    await runtimeEnvironmentSupportsCapability('env-new', CAPABILITY)
    expect(peekRuntimeEnvironmentCapability('env-new', CAPABILITY)).toBe(true)
  })

  it('caches an old host answer for the TTL while async callers still re-probe it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    runtimeEnvironmentCall.mockResolvedValue(statusReply([]))
    await expect(runtimeEnvironmentSupportsCapability('env-old', CAPABILITY)).resolves.toBe(false)
    expect(peekRuntimeEnvironmentCapability('env-old', CAPABILITY)).toBe(false)
    vi.setSystemTime(new Date(59_999))
    expect(peekRuntimeEnvironmentCapability('env-old', CAPABILITY)).toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledOnce()
    // The async verdict is unchanged: a negative answer still re-probes so an upgrade is seen.
    await runtimeEnvironmentSupportsCapability('env-old', CAPABILITY)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date(59_999 + 59_999))
    expect(peekRuntimeEnvironmentCapability('env-old', CAPABILITY)).toBe(false)
    vi.setSystemTime(new Date(59_999 + 60_000))
    expect(peekRuntimeEnvironmentCapability('env-old', CAPABILITY)).toBeUndefined()
  })
})
