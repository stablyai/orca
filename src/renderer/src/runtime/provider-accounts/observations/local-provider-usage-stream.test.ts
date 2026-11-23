import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from './runtime-provider-accounts-client'

vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

function snapshot(accountId: string, usedPercent: number): ProviderAccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: accountId },
    rateLimits: createEmptyRateLimitState({
      codex: {
        provider: 'codex',
        status: 'ok',
        error: null,
        updatedAt: 1,
        weekly: null,
        session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null }
      }
    })
  }
}

function streamEvent(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'usage', ok: true, result, _meta: { runtimeId: 'host' } }
}

describe('local provider usage stream', () => {
  // Why: no claudeAccounts/codexAccounts stubs, so a separate one-shot roster read would throw.
  it('delivers account switches with their matching quotas and reports a closed stream', () => {
    let receive: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      api: {
        runtime: {
          subscribe: (_request: unknown, onResponse: typeof receive) => {
            receive = onResponse
            return Promise.resolve({ unsubscribe: vi.fn() })
          }
        }
      }
    })
    const received: ProviderAccountsSnapshot[] = []
    const lost = vi.fn()
    const watcher = watchProviderAccounts(
      { kind: 'local' },
      { onSnapshot: (value) => received.push(value), onError: lost, onClosedAfterSnapshot: lost },
      { liveLocalUsage: true }
    )
    receive(streamEvent({ type: 'ready', snapshot: snapshot('work', 62) }))
    receive(streamEvent({ type: 'snapshot', snapshot: snapshot('personal', 17) }))
    expect(
      received.map((value) => [
        value.codex.activeAccountId,
        value.rateLimits?.codex?.session?.usedPercent
      ])
    ).toEqual([
      ['work', 62],
      ['personal', 17]
    ])
    receive(streamEvent({ type: 'end' }))
    expect(lost).toHaveBeenCalledOnce()
    watcher.close()
  })
})
