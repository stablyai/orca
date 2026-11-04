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
    // Wrap the fallback proxy: its synthetic then property would keep a bare async return pending forever.
    return { api: globals.window.api }
  }

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
