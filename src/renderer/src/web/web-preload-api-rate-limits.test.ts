import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../shared/rate-limit-state-factory'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

type SubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError?: (error: unknown) => void
  onClose?: () => void
}

function usageState(claudeSessionPercent: number): RateLimitState {
  const state = createEmptyRateLimitState()
  return {
    ...state,
    claude: { marker: `claude-${claudeSessionPercent}` } as unknown as RateLimitState['claude']
  }
}

function snapshot(rateLimits: RateLimitState | null, claudeActive: string | null = null) {
  return {
    claude: {
      accounts: [],
      activeAccountId: claudeActive,
      activeAccountIdsByRuntime: { host: claudeActive, wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits
  }
}

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('web rate limits and accounts preload API', () => {
  let calls: { method: string; params: unknown }[]
  let callResults: Record<string, unknown>
  let subscriptions: { method: string; callbacks: SubscriptionCallbacks; unsubscribe: () => void }[]

  beforeEach(() => {
    vi.resetModules()
    calls = []
    callResults = {}
    subscriptions = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          if (!(method in callResults)) {
            return Promise.resolve({
              id: 'r',
              ok: false,
              error: { code: 'method_not_found', message: method },
              _meta: { runtimeId: 'runtime-1' }
            } as RuntimeRpcResponse<unknown>)
          }
          return Promise.resolve(ok(callResults[method]))
        }

        subscribe(
          method: string,
          _params: unknown,
          callbacks: SubscriptionCallbacks
        ): Promise<{ unsubscribe: () => void }> {
          const entry = { method, callbacks, unsubscribe: vi.fn() }
          subscriptions.push(entry)
          return Promise.resolve({ unsubscribe: entry.unsubscribe })
        }

        close(): void {}
      }
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  async function install() {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    // Why wrapped: window.api is a fallback proxy that answers `then`, so
    // returning it bare from an async function would never settle.
    return { api: globals.window.api }
  }

  it('reads usage from the paired server instead of an empty local state', async () => {
    callResults['accounts.list'] = snapshot(usageState(10))
    const { api } = await install()

    await expect(api.rateLimits.get()).resolves.toEqual(usageState(10))
    expect(calls).toContainEqual({ method: 'accounts.list', params: { refreshUsage: false } })
  })

  it('asks the server to refresh usage on refresh and inactive-account fetches', async () => {
    callResults['accounts.list'] = snapshot(usageState(20))
    const { api } = await install()

    await expect(api.rateLimits.refresh()).resolves.toEqual(usageState(20))
    await api.rateLimits.fetchInactiveClaudeAccounts()

    const refreshCalls = calls.filter(
      (call) =>
        call.method === 'accounts.list' &&
        (call.params as { refreshUsage: boolean }).refreshUsage === true
    )
    expect(refreshCalls).toHaveLength(2)
  })

  it('falls back to an empty state when the server cannot answer', async () => {
    const { api } = await install()

    await expect(api.rateLimits.get()).resolves.toEqual(createEmptyRateLimitState())
  })

  it('streams usage pushed by the server and stops when the last listener leaves', async () => {
    const { api } = await install()
    const received: RateLimitState[] = []

    const unsubscribe = api.rateLimits.onUpdate((state) => received.push(state))
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    expect(subscriptions[0].method).toBe('accounts.subscribe')

    subscriptions[0].callbacks.onResponse(ok({ type: 'ready', snapshot: snapshot(usageState(1)) }))
    subscriptions[0].callbacks.onResponse(
      ok({ type: 'snapshot', snapshot: snapshot(usageState(2)) })
    )
    // A host that predates usage in its snapshot publishes nothing rather than an empty bar.
    subscriptions[0].callbacks.onResponse(ok({ type: 'snapshot', snapshot: snapshot(null) }))
    expect(received).toEqual([usageState(1), usageState(2)])

    unsubscribe()
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('resubscribes after the server closes the usage stream', async () => {
    const { api } = await install()
    api.rateLimits.onUpdate(() => {})
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))

    vi.useFakeTimers()
    subscriptions[0].callbacks.onClose?.()
    expect(subscriptions).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
  })

  it('lists and switches Claude accounts on the paired server', async () => {
    const selected = snapshot(null, 'account-b').claude
    callResults['accounts.list'] = snapshot(usageState(3), 'account-a')
    callResults['accounts.selectClaude'] = selected
    const { api } = await install()

    await expect(api.claudeAccounts.list()).resolves.toEqual(snapshot(null, 'account-a').claude)
    await expect(api.claudeAccounts.select({ accountId: 'account-b' })).resolves.toEqual(selected)
    expect(calls).toContainEqual({
      method: 'accounts.selectClaude',
      params: { accountId: 'account-b' }
    })
  })

  it('switches Codex accounts on the paired server', async () => {
    const selected = { ...snapshot(null).codex, activeAccountId: 'codex-b' }
    callResults['accounts.list'] = snapshot(usageState(4))
    callResults['accounts.selectCodex'] = selected
    const { api } = await install()

    await expect(api.codexAccounts.select({ accountId: 'codex-b' })).resolves.toEqual(selected)
    expect(calls).toContainEqual({
      method: 'accounts.selectCodex',
      params: { accountId: 'codex-b' }
    })
  })
})
