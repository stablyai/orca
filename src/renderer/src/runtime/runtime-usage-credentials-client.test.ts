import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callMiniMaxCredentials,
  callZcodePlanCredentials,
  UsageCredentialsHostOutdatedError
} from './runtime-usage-credentials-client'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

const local = {
  minimaxCredentials: {
    getStatus: vi.fn(),
    saveApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    saveCookie: vi.fn(),
    clearCookie: vi.fn()
  },
  zcodePlanCredentials: { getStatus: vi.fn(), saveApiKey: vi.fn(), clearApiKey: vi.fn() }
}
const host = { kind: 'environment' as const, environmentId: 'server-a' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(true)
  vi.mocked(callRuntimeRpc).mockResolvedValue({ apiKeyConfigured: true })
  vi.stubGlobal('window', { api: local })
})

describe('usage credential routing', () => {
  it('keeps this computer’s keys on the local IPC', async () => {
    await callMiniMaxCredentials({ kind: 'local' }, 'saveApiKey', 'key-a')
    await callZcodePlanCredentials({ kind: 'local' }, 'clearApiKey')

    expect(local.minimaxCredentials.saveApiKey).toHaveBeenCalledWith('key-a')
    expect(local.zcodePlanCredentials.clearApiKey).toHaveBeenCalledOnce()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['saveApiKey', 'accounts.minimaxSaveApiKey', { apiKey: 'key-a' }],
    ['saveCookie', 'accounts.minimaxSaveSessionCookie', { cookie: 'key-a' }],
    ['clearCookie', 'accounts.minimaxClearSessionCookie', undefined],
    ['getStatus', 'accounts.minimaxCredentialsStatus', undefined]
  ] as const)('sends MiniMax %s to the selected host only', async (action, method, params) => {
    await callMiniMaxCredentials(host, action, 'key-a')

    expect(callRuntimeRpc).toHaveBeenCalledWith(host, method, params, { timeoutMs: 20_000 })
    expect(local.minimaxCredentials[action]).not.toHaveBeenCalled()
  })

  it('sends the GLM key to the selected host only', async () => {
    await callZcodePlanCredentials(host, 'saveApiKey', 'key-b')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      host,
      'accounts.zcodePlanSaveApiKey',
      { apiKey: 'key-b' },
      { timeoutMs: 20_000 }
    )
    expect(local.zcodePlanCredentials.saveApiKey).not.toHaveBeenCalled()
  })

  it('refuses an older host before anything is sent, and never saves locally instead', async () => {
    vi.mocked(runtimeEnvironmentSupportsCapability).mockResolvedValue(false)

    await expect(callMiniMaxCredentials(host, 'saveApiKey', 'key-a')).rejects.toBeInstanceOf(
      UsageCredentialsHostOutdatedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(local.minimaxCredentials.saveApiKey).not.toHaveBeenCalled()
  })

  it('reads a method_not_found answer as an older host', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'a',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'server-a' }
      })
    )

    await expect(callZcodePlanCredentials(host, 'getStatus')).rejects.toBeInstanceOf(
      UsageCredentialsHostOutdatedError
    )
  })

  it('passes an unreachable host’s error through so callers show it as unverifiable', async () => {
    vi.mocked(runtimeEnvironmentSupportsCapability).mockRejectedValue(new Error('timed out'))

    await expect(callMiniMaxCredentials(host, 'getStatus')).rejects.toThrow('timed out')
  })
})
