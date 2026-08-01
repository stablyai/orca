// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { act } from 'react'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { useRemoteAccountUsageSync } from './remote-account-usage-sync'

type WatchHandlers = {
  onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
  onError: (error: unknown) => void
  onClosed?: () => void
}

const watchProviderAccounts = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({ watchProviderAccounts }))

const closeWatcher = vi.fn()
let watchHandlers: WatchHandlers | null = null

function setActiveEnvironment(environmentId: string | null): void {
  act(() => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: environmentId }
    })
  })
}

function snapshotFixture(
  rateLimits: ProviderAccountsSnapshot['rateLimits']
): ProviderAccountsSnapshot {
  const emptyAccounts = {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
  return { claude: emptyAccounts, codex: emptyAccounts, rateLimits }
}

function remoteRateLimitsFixture(
  marker: string
): NonNullable<ProviderAccountsSnapshot['rateLimits']> {
  return {
    ...useAppStore.getState().rateLimits,
    claude: {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: marker,
      status: 'ok'
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  watchProviderAccounts.mockReset()
  closeWatcher.mockReset()
  watchHandlers = null
  watchProviderAccounts.mockImplementation((_settings: unknown, handlers: WatchHandlers) => {
    watchHandlers = handlers
    return { close: closeWatcher }
  })
  useAppStore.setState({ remoteRateLimits: null })
  setActiveEnvironment(null)
})

afterEach(() => {
  // Why: this config has no vitest globals, so testing-library's auto-cleanup
  // never registers; without this, hooks from prior tests keep resubscribing.
  cleanup()
  vi.useRealTimers()
})

describe('useRemoteAccountUsageSync', () => {
  it('does not subscribe while local accounts own usage', () => {
    renderHook(() => useRemoteAccountUsageSync())

    expect(watchProviderAccounts).not.toHaveBeenCalled()
    expect(useAppStore.getState().remoteRateLimits).toBeNull()
  })

  it('mirrors remote snapshots into the store and ignores rate-limit-less frames', () => {
    setActiveEnvironment('env-1')
    renderHook(() => useRemoteAccountUsageSync())

    expect(watchProviderAccounts).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'env-1' },
      expect.any(Object)
    )

    act(() => {
      watchHandlers?.onSnapshot(snapshotFixture(remoteRateLimitsFixture('pushed')))
    })
    expect(useAppStore.getState().remoteRateLimits?.state.claude?.error).toBe('pushed')

    act(() => {
      watchHandlers?.onSnapshot(snapshotFixture(null))
    })
    expect(useAppStore.getState().remoteRateLimits?.state.claude?.error).toBe('pushed')
  })

  it('clears the mirror and resubscribes when the account owner changes', () => {
    setActiveEnvironment('env-1')
    const { rerender } = renderHook(() => useRemoteAccountUsageSync())
    act(() => {
      watchHandlers?.onSnapshot(snapshotFixture(remoteRateLimitsFixture('old-owner')))
    })

    setActiveEnvironment('env-2')
    rerender()

    expect(closeWatcher).toHaveBeenCalled()
    expect(useAppStore.getState().remoteRateLimits).toBeNull()
    expect(watchProviderAccounts).toHaveBeenLastCalledWith(
      { activeRuntimeEnvironmentId: 'env-2' },
      expect.any(Object)
    )
  })

  it('resubscribes with a delay after the stream closes or errors', () => {
    setActiveEnvironment('env-1')
    renderHook(() => useRemoteAccountUsageSync())
    expect(watchProviderAccounts).toHaveBeenCalledTimes(1)

    act(() => {
      watchHandlers?.onClosed?.()
    })
    expect(watchProviderAccounts).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(watchProviderAccounts).toHaveBeenCalledTimes(2)

    // Why: consecutive failures back off; the second retry needs 10s, not 5s.
    act(() => {
      watchHandlers?.onError(new Error('unreachable'))
      vi.advanceTimersByTime(5_000)
    })
    expect(watchProviderAccounts).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(watchProviderAccounts).toHaveBeenCalledTimes(3)
  })

  it('stops retrying after unmount', () => {
    setActiveEnvironment('env-1')
    const { unmount } = renderHook(() => useRemoteAccountUsageSync())

    act(() => {
      watchHandlers?.onClosed?.()
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(watchProviderAccounts).toHaveBeenCalledTimes(1)
    expect(closeWatcher).toHaveBeenCalled()
  })
})
