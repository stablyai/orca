import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { createEmptyRateLimitState } from '../../../../../shared/rate-limit-state-factory'
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
  it('delivers account switches with their matching quotas and reports a closed stream', async () => {
    let receive: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    const unsubscribe = vi.fn()
    const handle = Promise.resolve({ unsubscribe })
    const list = vi.fn(() => {
      throw new Error('A usage stream must not read a separate roster')
    })
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      api: {
        runtime: {
          subscribe: (_request: unknown, onResponse: typeof receive) => {
            receive = onResponse
            return handle
          }
        },
        claudeAccounts: { list },
        codexAccounts: { list }
      }
    })
    const received: ProviderAccountsSnapshot[] = []
    const lost = vi.fn()
    const watcher = watchProviderAccounts(
      { kind: 'local' },
      {
        onSnapshot: (value) => received.push(value),
        onError: lost,
        onClosedAfterSnapshot: lost
      },
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
    await handle
    expect(unsubscribe).toHaveBeenCalledOnce()
    receive(streamEvent({ type: 'snapshot', snapshot: snapshot('stale', 99) }))
    expect(received.at(-1)?.codex.activeAccountId).toBe('personal')
  })

  it('releases a subscription that opens after its consumer has left', async () => {
    let receive: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    const handle = Promise.withResolvers<{ unsubscribe: () => void }>()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      api: {
        runtime: {
          subscribe: (_request: unknown, onResponse: typeof receive) => {
            receive = onResponse
            return handle.promise
          }
        }
      }
    })
    const onSnapshot = vi.fn()
    const watcher = watchProviderAccounts(
      { kind: 'local' },
      { onSnapshot, onError: vi.fn() },
      { liveLocalUsage: true }
    )
    watcher.close()
    const unsubscribe = vi.fn()
    handle.resolve({ unsubscribe })
    await handle.promise
    receive(streamEvent({ type: 'ready', snapshot: snapshot('late', 99) }))
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
