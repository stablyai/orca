// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

type Handlers = {
  onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
  onError: (error: unknown) => void
  onClosedAfterSnapshot?: () => void
}

type Watcher = { target: RuntimeClientTarget; handlers: Handlers }

const localOwner = { target: { kind: 'local' as const }, wslHostDistro: null }

const mocks = vi.hoisted(() => {
  const state: { owner: RuntimeClientTarget; watchers: Watcher[]; callRuntimeRpc: Mock } = {
    owner: { kind: 'local' },
    watchers: [],
    callRuntimeRpc: vi.fn()
  }
  return state
})

vi.mock('../../../runtime/provider-accounts/ownership/use-active-account-owner', () => ({
  useActiveAccountOwner: () => ({ target: mocks.owner, wslHostDistro: null })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/runtime/provider-accounts/observations/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (target: RuntimeClientTarget, handlers: Handlers) => {
    mocks.watchers.push({ target, handlers })
    return { close: () => {} }
  }
}))
vi.mock('../../../store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: null, runtimeEnvironments: [{ id: 'mini', name: 'Mac Mini' }] })
}))

const { useAccountOwnerUsage, useOwnerUsageRateLimits } =
  await import('./use-owner-usage-rate-limits')

function provider(id: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider: id,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function snapshot(rateLimits: ProviderAccountsSnapshot['rateLimits']): ProviderAccountsSnapshot {
  const empty = {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
  return { claude: empty, codex: empty, rateLimits }
}

const local = createEmptyRateLimitState({ claude: provider('claude', 11) })

describe('owner usage', () => {
  beforeEach(() => {
    mocks.owner = { kind: 'local' }
    mocks.watchers.length = 0
    mocks.callRuntimeRpc.mockReset()
  })
  afterEach(() => cleanup())

  it('reads the Settings host instead of the focused workspace host', () => {
    mocks.owner = { kind: 'environment', environmentId: 'focused-other-host' }
    const selected: RuntimeClientTarget = { kind: 'environment', environmentId: 'mini' }
    const owner = { target: selected, wslHostDistro: null }
    const { result } = renderHook(() => useAccountOwnerUsage(owner, local, true))
    expect(result.current.owner).toEqual(owner)
    expect(mocks.watchers[0].target).toEqual(selected)
    const accounts = snapshot(createEmptyRateLimitState({ codex: provider('codex', 37) }))
    act(() => mocks.watchers[0].handlers.onSnapshot(accounts))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(37)
  })

  it('reads local accounts and quotas from one snapshot and flags them after a stream failure', () => {
    const { result, rerender } = renderHook(
      ({ limits }) => useAccountOwnerUsage(localOwner, limits, true),
      { initialProps: { limits: local } }
    )
    expect(mocks.watchers[0].target).toEqual({ kind: 'local' })
    const accounts = snapshot(createEmptyRateLimitState({ codex: provider('codex', 37) }))
    act(() => mocks.watchers[0].handlers.onSnapshot(accounts))
    rerender({ limits: createEmptyRateLimitState({ codex: provider('codex', 77) }) })
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(37)
    expect(result.current.accountsUnverifiable).toBe(false)
    act(() => mocks.watchers[0].handlers.onError(new Error('account list unavailable')))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.accountsUnverifiable).toBe(true)
    act(() => mocks.watchers[0].handlers.onSnapshot(snapshot(local)))
    expect(result.current.accountsUnverifiable).toBe(false)
  })

  it('keeps a newer streamed snapshot when an older forced refresh completes', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    let finish: (value: ProviderAccountsSnapshot) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(
      new Promise<ProviderAccountsSnapshot>((resolve) => {
        finish = resolve
      })
    )
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    const pending = result.current.refreshRemote?.()
    const fresh = snapshot(createEmptyRateLimitState({ codex: provider('codex', 24) }))
    act(() => mocks.watchers[0].handlers.onSnapshot(fresh))
    await act(async () => {
      finish(snapshot(createEmptyRateLimitState({ codex: provider('codex', 90) })))
      await pending
    })
    expect(result.current.accounts).toBe(fresh)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(24)
  })
})
