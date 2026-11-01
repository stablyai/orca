import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USAGE_HISTORY_RUNTIME_CAPABILITY } from '../../../shared/usage-history-rpc'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const fixture = vi.hoisted(() => {
  const state: { calls: { method: string; params: unknown }[]; supported: boolean } = {
    calls: [],
    supported: true
  }
  return state
})
vi.mock('./web-runtime-client', () => ({
  WebRuntimeClient: class {
    call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
      fixture.calls.push({ method, params })
      return Promise.resolve({
        id: method,
        ok: true,
        _meta: { runtimeId: 'paired-runtime' },
        result:
          method === 'status.get'
            ? {
                protocolVersion: 3,
                minCompatibleClientVersion: 2,
                runtimeId: 'paired-runtime',
                capabilities: fixture.supported ? [USAGE_HISTORY_RUNTIME_CAPABILITY] : []
              }
            : {
                scanState: {
                  enabled: false,
                  isScanning: false,
                  lastScanCompletedAt: 123,
                  lastScanError: null
                },
                history: []
              }
      })
    }
    close(): void {}
  }
}))

beforeEach(() => {
  vi.resetModules()
  fixture.calls = []
  fixture.supported = true
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function install() {
  const { storage } = installBrowserGlobals()
  writeStoredRuntimeEnvironment(storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  return import('../components/stats/usage-history-client')
}

describe('paired browser historical usage bridge', () => {
  it('uses the active paired runtime through the existing generic web/preload RPC bridge', async () => {
    const { resolveUsageHistoryTarget, supportsUsageHistory, usageHistoryApi } = await install()
    const target = await resolveUsageHistoryTarget({ kind: 'local' })
    expect(target).toEqual({ kind: 'environment', environmentId: 'web-env-1' })
    expect(await supportsUsageHistory(target)).toBe(true)
    const api = usageHistoryApi(target, 'codex')
    expect(
      await api.getSnapshot({ scope: 'all', range: 'all', includeHistory: true })
    ).toMatchObject({ history: [], scanState: { lastScanCompletedAt: 123 } })
    await api.setEnabled({ enabled: true })
    await api.refresh({ force: true })
    expect(fixture.calls).toEqual([
      { method: 'status.get', params: undefined },
      {
        method: 'usage.getSnapshot',
        params: { provider: 'codex', scope: 'all', range: 'all', includeHistory: true }
      },
      { method: 'usage.setEnabled', params: { provider: 'codex', enabled: true } },
      { method: 'usage.refresh', params: { provider: 'codex', force: true } }
    ])
  })

  it('negotiates an older paired host as unsupported without reading a desktop fallback', async () => {
    const { resolveUsageHistoryTarget, supportsUsageHistory } = await install()
    fixture.supported = false
    expect(await supportsUsageHistory(await resolveUsageHistoryTarget({ kind: 'local' }))).toBe(
      false
    )
    expect(fixture.calls).toEqual([{ method: 'status.get', params: undefined }])
  })
})
