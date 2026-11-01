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

  it('uses the explicit Settings owner and exposes its account roster with no focused-host substitution', () => {
    mocks.owner = { kind: 'environment', environmentId: 'focused-other-host' }
    const selected: RuntimeClientTarget = { kind: 'environment', environmentId: 'mini' }
    const { result } = renderHook(() => useOwnerUsageRateLimits(local, selected, true))
    expect(mocks.watchers[0].target).toEqual(selected)
    const accounts = snapshot(createEmptyRateLimitState({ codex: provider('codex', 37) }))
    act(() => mocks.watchers[0].handlers.onSnapshot(accounts))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(37)
    act(() => mocks.watchers[0].handlers.onError(new Error('closed')))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.accountsUnverifiable).toBe(true)
  })

  it('can read the local account roster without opening a remote usage stream', () => {
    const { result } = renderHook(() => useOwnerUsageRateLimits(local, { kind: 'local' }, true))
    expect(mocks.watchers[0].target).toEqual({ kind: 'local' })
    const accounts = snapshot(null)
    act(() => mocks.watchers[0].handlers.onSnapshot(accounts))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.rateLimits).toBe(local)
    expect(result.current.accountsUnverifiable).toBe(false)
  })

  it('marks retained local accounts unverifiable after a watcher failure and recovers on a fresh snapshot', () => {
    const { result } = renderHook(() => useOwnerUsageRateLimits(local, { kind: 'local' }, true))
    const accounts = snapshot(null)
    act(() => mocks.watchers[0].handlers.onSnapshot(accounts))
    act(() => mocks.watchers[0].handlers.onError(new Error('account list unavailable')))
    expect(result.current.accounts).toBe(accounts)
    expect(result.current.accountsUnverifiable).toBe(true)
    act(() => mocks.watchers[0].handlers.onSnapshot(snapshot(null)))
    expect(result.current.accountsUnverifiable).toBe(false)
  })

  it('keeps newer streamed account identity and quotas when an older forced refresh completes', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    let finish: (value: ProviderAccountsSnapshot) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValue(
      new Promise<ProviderAccountsSnapshot>((resolve) => {
        finish = resolve
      })
    )
    const { result } = renderHook(() => useOwnerUsageRateLimits(local, undefined, true))
    const pending = result.current.refreshRemote?.()
    const fresh = snapshot(createEmptyRateLimitState({ codex: provider('codex', 24) }))
    fresh.codex.activeAccountId = 'new-account'
    act(() => mocks.watchers[0].handlers.onSnapshot(fresh))
    const old = snapshot(createEmptyRateLimitState({ codex: provider('codex', 90) }))
    old.codex.activeAccountId = 'old-account'
    await act(async () => {
      finish(old)
      await pending
    })
    expect(result.current.accounts).toBe(fresh)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(24)
  })

  it('keeps a newer refresh when overlapping forced refreshes finish out of order', async () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const finishes: ((value: ProviderAccountsSnapshot) => void)[] = []
    mocks.callRuntimeRpc.mockImplementation(
      () =>
        new Promise<ProviderAccountsSnapshot>((resolve) => {
          finishes.push(resolve)
        })
    )
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    const older = result.current.refreshRemote?.()
    const newer = result.current.refreshRemote?.()
    const fresh = snapshot(createEmptyRateLimitState({ codex: provider('codex', 24) }))
    await act(async () => {
      finishes[1](fresh)
      await newer
    })
    await act(async () => {
      finishes[0](snapshot(createEmptyRateLimitState({ codex: provider('codex', 90) })))
      await older
    })
    expect(result.current.accounts).toBe(fresh)
    expect(result.current.rateLimits.codex?.session?.usedPercent).toBe(24)
  })

  it('invalidates local account identity when its quota snapshot changes and ignores a delayed old roster', () => {
    const { result, rerender } = renderHook(
      ({ limits }) => useOwnerUsageRateLimits(limits, { kind: 'local' }, true),
      {
        initialProps: { limits: local }
      }
    )
    const first = mocks.watchers[0]
    const original = snapshot(null)
    act(() => first.handlers.onSnapshot(original))
    expect(result.current.accounts).toBe(original)
    const next = createEmptyRateLimitState({ codex: provider('codex', 77) })
    rerender({ limits: next })
    expect(first.closed).toBe(true)
    expect(result.current.accounts).toBeNull()
    const fresh = snapshot(null)
    fresh.codex.activeAccountId = 'new-account'
    act(() => mocks.watchers[1].handlers.onSnapshot(fresh))
    act(() => first.handlers.onSnapshot(original))
    expect(result.current.accounts).toBe(fresh)
    expect(result.current.rateLimits).toBe(next)
  })

  it('reports an older host without published usage as unavailable, not loading', () => {
    mocks.owner = { kind: 'environment', environmentId: 'mini' }
    const { result } = renderHook(() => useOwnerUsageRateLimits(local))
    act(() => mocks.watchers[0].handlers.onSnapshot(snapshot(null)))
    expect(result.current.rateLimits.claude?.status).toBe('error')
    expect(result.current.rateLimits.claude?.usageMetadata?.unverifiableOwner).toBe(true)
    expect(result.current.rateLimits.claude?.error).toContain('Mac Mini does not report usage')
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
