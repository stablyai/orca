// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { useRemoteUsageRateLimits } from './remote-usage-rate-limits'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const mocks = vi.hoisted(() => ({
  runtimeEnvironments: [] as { id: string; name: string }[],
  watchers: [] as {
    ownerId: string | null
    closed: boolean
    onSnapshot: (snapshot: { rateLimits: RateLimitState | null }) => void
    onError: (error: unknown) => void
  }[],
  fetchSnapshot: vi.fn()
}))

vi.mock('../../store', () => {
  const state = (): Record<string, unknown> => ({ runtimeEnvironments: mocks.runtimeEnvironments })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  hasRemoteProviderAccountOwner: (
    settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
  ) => Boolean(settings?.activeRuntimeEnvironmentId?.trim()),
  watchProviderAccounts: (
    settings: { activeRuntimeEnvironmentId: string | null },
    handlers: {
      onSnapshot: (snapshot: { rateLimits: RateLimitState | null }) => void
      onError: (error: unknown) => void
    }
  ) => {
    const watcher = {
      ownerId: settings.activeRuntimeEnvironmentId,
      closed: false,
      onSnapshot: handlers.onSnapshot,
      onError: handlers.onError
    }
    mocks.watchers.push(watcher)
    return {
      close: () => {
        watcher.closed = true
      }
    }
  },
  fetchProviderAccountsSnapshot: (settings: { activeRuntimeEnvironmentId: string | null }) =>
    mocks.fetchSnapshot(settings)
}))

function provider(usedPercent: number, updatedAt: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function rateLimits(usedPercent: number, updatedAt: number): RateLimitState {
  return {
    claude: provider(usedPercent, updatedAt),
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function latestWatcher(): (typeof mocks.watchers)[number] {
  const watcher = mocks.watchers.at(-1)
  if (!watcher) {
    throw new Error('no watcher opened')
  }
  return watcher
}

describe('useRemoteUsageRateLimits', () => {
  beforeEach(() => {
    mocks.runtimeEnvironments = [
      { id: 'env-a', name: 'Mac Mini' },
      { id: 'env-b', name: 'Studio' }
    ]
    mocks.watchers = []
    mocks.fetchSnapshot.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('stays local and opens no watcher without a remote Active Server', () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: null })
    )

    expect(result.current.state).toEqual({ kind: 'local' })
    expect(result.current.refresh).toBeNull()
    expect(mocks.watchers).toHaveLength(0)
  })

  it('is pending until the owning server sends a snapshot, then reports its numbers', () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )

    expect(result.current.state).toEqual({ kind: 'remote-pending' })

    act(() => {
      latestWatcher().onSnapshot({ rateLimits: rateLimits(71, 5_000) })
    })

    expect(result.current.state).toEqual({ kind: 'remote', rateLimits: rateLimits(71, 5_000) })
  })

  it('reports the owner as unreachable when the watcher fails, and recovers on the next snapshot', () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )

    act(() => {
      latestWatcher().onError(new Error('Timed out waiting for remote provider accounts.'))
    })

    // Why: swallowing this error left the badge spinning forever, which
    // docs/reference/ssh-execution-boundary.md forbids - loss of contact is
    // 'unverifiable', not 'in progress'.
    expect(result.current.state).toEqual({
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable',
      lastKnown: null
    })

    act(() => {
      latestWatcher().onSnapshot({ rateLimits: rateLimits(12, 6_000) })
    })

    expect(result.current.state.kind).toBe('remote')
  })

  it('keeps the last snapshot the owner vouched for when contact is lost', () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )

    act(() => {
      latestWatcher().onSnapshot({ rateLimits: rateLimits(71, 5_000) })
    })
    act(() => {
      latestWatcher().onError(new Error('Remote provider account subscription closed.'))
    })

    // Why: the badge blanks those numbers but keeps the server's bars in place;
    // dropping them would make the bars silently disappear on a thin client.
    expect(result.current.state).toEqual({
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable',
      lastKnown: rateLimits(71, 5_000)
    })
  })

  it('does not spin forever when the owner answers without usage (older host)', () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )

    // Why: this snapshot disarms the client's first-snapshot timeout, so
    // ignoring it left the badge on the pulsing placeholder with no recovery.
    act(() => {
      latestWatcher().onSnapshot({ rateLimits: null })
    })

    expect(result.current.state).toEqual({
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'usage-not-published',
      lastKnown: null
    })
  })

  it('reports a usage-less manual refresh instead of holding the spinner', async () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )
    mocks.fetchSnapshot.mockResolvedValue({ rateLimits: null })

    await act(async () => {
      await result.current.refresh!()
    })

    expect(result.current.state.kind).toBe('remote-unverifiable')
  })

  it('falls back to a generic server label for an unknown environment id', () => {
    mocks.runtimeEnvironments = []
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )

    act(() => {
      latestWatcher().onError(new Error('Remote provider account subscription closed.'))
    })

    expect(result.current.state).toEqual({
      kind: 'remote-unverifiable',
      ownerLabel: 'Remote server',
      reason: 'unreachable',
      lastKnown: null
    })
  })

  it("never renders server A's usage under server B", () => {
    const { result, rerender } = renderHook(
      (props: { id: string }) => useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: props.id }),
      { initialProps: { id: 'env-a' } }
    )

    const watcherA = latestWatcher()
    act(() => {
      watcherA.onSnapshot({ rateLimits: rateLimits(71, 5_000) })
    })
    expect(result.current.state.kind).toBe('remote')

    rerender({ id: 'env-b' })

    expect(watcherA.closed).toBe(true)
    expect(result.current.state).toEqual({ kind: 'remote-pending' })

    // A late in-flight callback from A must not land under B's label.
    act(() => {
      watcherA.onSnapshot({ rateLimits: rateLimits(99, 9_000) })
    })
    expect(result.current.state).toEqual({ kind: 'remote-pending' })
  })

  it('keeps the refresh promise open until data newer than the click arrives', async () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )
    act(() => {
      latestWatcher().onSnapshot({ rateLimits: rateLimits(71, 5_000) })
    })

    // Why: fetchProviderAccountsSnapshot resolves off the subscribe-time `ready`
    // frame, which the host emits *before* it re-reads usage. Resolving there
    // would stop the spinner before any newer data can exist.
    let settled = false
    mocks.fetchSnapshot.mockResolvedValue({ rateLimits: rateLimits(71, 5_000) })
    const refresh = result.current.refresh
    expect(refresh).not.toBeNull()

    await act(async () => {
      const pending = refresh!().then(() => {
        settled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      latestWatcher().onSnapshot({ rateLimits: rateLimits(73, 7_000) })
      await pending
    })

    expect(settled).toBe(true)
    expect(mocks.fetchSnapshot).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-a' })
    expect(result.current.state).toEqual({ kind: 'remote', rateLimits: rateLimits(73, 7_000) })
  })

  it('reports the owner as unreachable when a manual refresh cannot reach it', async () => {
    const { result } = renderHook(() =>
      useRemoteUsageRateLimits({ activeRuntimeEnvironmentId: 'env-a' })
    )
    mocks.fetchSnapshot.mockRejectedValue(new Error('offline'))

    await act(async () => {
      await result.current.refresh!()
    })

    expect(result.current.state).toEqual({
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable',
      lastKnown: null
    })
  })
})
