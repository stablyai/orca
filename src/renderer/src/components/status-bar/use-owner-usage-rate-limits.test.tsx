// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'

type Handlers = {
  onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
  onError: (error: unknown) => void
  onClosedAfterSnapshot?: () => void
}

type Watcher = { target: RuntimeClientTarget; handlers: Handlers; closed: boolean }

const mocks = vi.hoisted(() => {
  const state: { owner: RuntimeClientTarget; watchers: Watcher[]; callRuntimeRpc: Mock } = {
    owner: { kind: 'local' },
    watchers: [],
    callRuntimeRpc: vi.fn()
  }
  return state
})

vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useActiveAccountOwner: () => ({ target: mocks.owner, wslHostDistro: null })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (target: RuntimeClientTarget, handlers: Handlers) => {
    const watcher = { target, handlers, closed: false }
    mocks.watchers.push(watcher)
    return {
      close: () => {
        watcher.closed = true
      }
    }
  }
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: null, runtimeEnvironments: [{ id: 'mini', name: 'Mac Mini' }] })
}))

const { useOwnerUsageRateLimits } = await import('./use-owner-usage-rate-limits')

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

describe('useOwnerUsageRateLimits', () => {
  beforeEach(() => {
    mocks.owner = { kind: 'local' }
    mocks.watchers.length = 0
    mocks.callRuntimeRpc.mockReset()
  })
  afterEach(() => cleanup())

  it('opens no watcher and keeps local usage when this device owns accounts', () => {
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    expect(mocks.watchers).toHaveLength(0)
    expect(result.current.rateLimits).toBe(local)
    expect(result.current.refreshRemote).toBeNull()
  })

  it("reads usage from the remote owner's accounts stream", () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    expect(mocks.watchers[0].target).toEqual({ kind: 'environment', environmentId: 'mini' })
    expect(result.current.remoteOwned).toBe(true)
    expect(result.current.rateLimits.claude?.session).toBeNull()

    act(() =>
      mocks.watchers[0].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 64) }))
      )
    )
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(64)
  })

  it('reports an older host without published usage as unavailable, not loading', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    act(() => mocks.watchers[0].handlers.onSnapshot(snapshot(null)))
    expect(result.current.rateLimits.claude?.status).toBe('error')
    expect(result.current.rateLimits.claude?.usageMetadata?.unverifiableOwner).toBe(true)
    expect(result.current.rateLimits.claude?.error).toContain('Mac Mini does not report usage')
  })

  it('turns loss of contact into an unverifiable verdict that keeps known bars', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    act(() =>
      mocks.watchers[0].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ codex: provider('codex', 30) }))
      )
    )
    act(() => mocks.watchers[0].handlers.onError(new Error('closed')))
    expect(result.current.rateLimits.codex?.session).toBeNull()
    expect(result.current.rateLimits.codex?.error).toContain('cannot reach Mac Mini')
  })

  it('never shows server A numbers under server B', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    const first = mocks.watchers[0]
    act(() =>
      first.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 90) }))
      )
    )
    mocks.owner = { kind: 'environment', environmentId: 'devbox' }
    rerender()
    expect(first.closed).toBe(true)
    expect(result.current.rateLimits.claude?.session).toBeNull()
    act(() =>
      first.handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 91) }))
      )
    )
    expect(result.current.rateLimits.claude?.session).toBeNull()
  })

  it('forces the owning host to refresh usage', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    mocks.callRuntimeRpc.mockResolvedValue(
      snapshot(createEmptyRateLimitState({ claude: provider('claude', 12) }))
    )
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    await act(async () => {
      await result.current.refreshRemote?.()
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'mini' },
      'accounts.list',
      { refreshUsage: true },
      expect.anything()
    )
    await waitFor(() => expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(12))
  })

  it('marks usage unverifiable when the stream closes after its first snapshot, then reconnects', () => {
    vi.useFakeTimers()
    try {
      mocks.owner = { kind: 'environment', environmentId: 'mini' }
      const { result } = renderHook(() => useOwnerUsageRateLimits(local))
      act(() =>
        mocks.watchers[0].handlers.onSnapshot(
          snapshot(createEmptyRateLimitState({ codex: provider('codex', 30) }))
        )
      )
      act(() => mocks.watchers[0].handlers.onClosedAfterSnapshot?.())
      expect(result.current.rateLimits.codex?.session).toBeNull()
      expect(result.current.rateLimits.codex?.error).toContain('cannot reach Mac Mini')
      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(mocks.watchers[0].closed).toBe(true)
      expect(mocks.watchers).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens the stream periodically so a host that does not poll still refreshes', () => {
    vi.useFakeTimers()
    try {
      mocks.owner = { kind: 'environment', environmentId: 'mini' }
      renderHook(() => useOwnerUsageRateLimits(local))
      act(() => {
        vi.advanceTimersByTime(5 * 60_000)
      })
      expect(mocks.watchers).toHaveLength(2)
      expect(mocks.watchers[0].closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a refresh that completes after the owner changed', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    let resolveRefresh: (value: ProviderAccountsSnapshot) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(
      new Promise<ProviderAccountsSnapshot>((resolve) => {
        resolveRefresh = resolve
      })
    )
    const { result, rerender } = renderHook(() => useOwnerUsageRateLimits(local))
    const pending = result.current.refreshRemote?.()
    mocks.owner = { kind: 'environment', environmentId: 'devbox' }
    rerender()
    act(() =>
      mocks.watchers[1].handlers.onSnapshot(
        snapshot(createEmptyRateLimitState({ claude: provider('claude', 20) }))
      )
    )
    await act(async () => {
      resolveRefresh(snapshot(createEmptyRateLimitState({ claude: provider('claude', 99) })))
      await pending
    })
    expect(result.current.rateLimits.claude?.session?.usedPercent).toBe(20)
  })
})
