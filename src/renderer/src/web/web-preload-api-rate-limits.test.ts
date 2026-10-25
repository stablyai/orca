import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
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

// Distinct, comparable states without hand-building a provider snapshot.
function usageState(inactiveCodexAccounts: number): RateLimitState {
  return createEmptyRateLimitState({
    inactiveCodexAccounts: Array.from({ length: inactiveCodexAccounts }, (_, index) => ({
      accountId: `codex-${index}`,
      rateLimits: null,
      updatedAt: 0,
      isFetching: false
    }))
  })
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

function notFound(method: string): RuntimeRpcFailure {
  return {
    id: 'r',
    ok: false,
    error: { code: 'method_not_found', message: method },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function isForcedRefresh(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'refreshUsage' in params &&
    params.refreshUsage === true
  )
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
            return Promise.resolve(notFound(method))
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
    // Concurrent refreshes share one server round trip.
    await Promise.all([
      api.rateLimits.fetchInactiveClaudeAccounts(),
      api.rateLimits.fetchInactiveCodexAccounts(),
      api.rateLimits.refresh()
    ])

    const refreshCalls = calls.filter(
      (call) => call.method === 'accounts.list' && isForcedRefresh(call.params)
    )
    expect(refreshCalls).toHaveLength(3)
  })

  it('falls back to an empty state when the server cannot answer', async () => {
    const { api } = await install()

    await expect(api.rateLimits.get()).resolves.toEqual(createEmptyRateLimitState())
  })

  it('keeps the last streamed usage when a refresh cannot reach the server', async () => {
    const { api } = await install()
    api.rateLimits.onUpdate(() => {})
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    subscriptions[0].callbacks.onResponse(ok({ type: 'ready', snapshot: snapshot(usageState(5)) }))

    await expect(api.rateLimits.refresh()).resolves.toEqual(usageState(5))
  })

  it('refuses to add or re-sign accounts with a reason instead of returning an empty roster', async () => {
    const { api } = await install()

    await expect(api.claudeAccounts.add()).rejects.toThrow(/desktop app/)
    await expect(api.codexAccounts.add()).rejects.toThrow(/desktop app/)
    await expect(api.codexAccounts.reauthenticate({ accountId: 'codex-a' })).rejects.toThrow(
      /desktop app/
    )
    expect(calls).toEqual([])
  })

  it('removes accounts on the paired server', async () => {
    const remaining = snapshot(null).claude
    callResults['accounts.removeClaude'] = remaining
    const { api } = await install()

    await expect(api.claudeAccounts.remove({ accountId: 'account-a' })).resolves.toEqual(remaining)
    expect(calls).toContainEqual({
      method: 'accounts.removeClaude',
      params: { accountId: 'account-a' }
    })
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

  it('selects a WSL Codex lane through the targeted RPC so the host lane is untouched', async () => {
    const selected = snapshot(null).codex
    callResults['accounts.selectCodexForTarget'] = selected
    const { api } = await install()

    await expect(
      api.codexAccounts.select({ accountId: null, runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual(selected)
    expect(calls).toContainEqual({
      method: 'accounts.selectCodexForTarget',
      params: { accountId: null, target: { runtime: 'wsl', wslDistro: 'Ubuntu' } }
    })
    expect(calls.some((call) => call.method === 'accounts.selectCodex')).toBe(false)
  })

  it('refuses a WSL Claude system-default switch instead of clearing the host lane', async () => {
    callResults['accounts.selectClaude'] = snapshot(null).claude
    const { api } = await install()

    await expect(
      api.claudeAccounts.select({ accountId: null, runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).rejects.toThrow(/desktop app/)
    expect(calls.some((call) => call.method === 'accounts.selectClaude')).toBe(false)
  })

  it('reopens the usage stream after a manual disconnect is lifted', async () => {
    const { api } = await install()
    const session = await import('./preload-api/web-runtime-session')
    api.rateLimits.onUpdate(() => {})
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))

    vi.useFakeTimers()
    const environmentId = session.requireActiveEnvironment().id
    session.manuallyDisconnectedEnvironmentIds.add(environmentId)
    subscriptions[0].callbacks.onClose?.()
    // The retry while disconnected must fail quietly and keep retrying.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(subscriptions).toHaveLength(1)

    session.manuallyDisconnectedEnvironmentIds.delete(environmentId)
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
  })
})
