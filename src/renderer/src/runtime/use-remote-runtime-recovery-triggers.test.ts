// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const { retryAllRemoteRuntimePtyRecoveriesNowMock, refreshRuntimeEnvironmentStatusMock, state } =
  vi.hoisted(() => ({
    retryAllRemoteRuntimePtyRecoveriesNowMock: vi.fn(),
    refreshRuntimeEnvironmentStatusMock: vi.fn((_environmentId: string) =>
      Promise.resolve('reachable' as const)
    ),
    state: {
      runtimeStatusByEnvironmentId: new Map<string, { status: unknown }>(),
      /** Mirrors a minimal store assembly that never registered the runtime-status slice. */
      omitRuntimeStatusSlice: false
    }
  }))

vi.mock('@/components/terminal-pane/remote-runtime-pty-recovery-state', () => ({
  retryAllRemoteRuntimePtyRecoveriesNow: retryAllRemoteRuntimePtyRecoveriesNowMock
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...state,
      refreshRuntimeEnvironmentStatusOutcome: state.omitRuntimeStatusSlice
        ? undefined
        : refreshRuntimeEnvironmentStatusMock
    }),
    subscribe: () => () => {}
  }
}))

import { useRemoteRuntimeRecoveryTriggers } from './use-remote-runtime-recovery-triggers'

describe('useRemoteRuntimeRecoveryTriggers', () => {
  let systemResumedCallback: (() => void) | null = null
  const unsubscribeSystemResumed = vi.fn()
  const onSystemResumed = vi.fn((callback: () => void) => {
    systemResumedCallback = callback
    return unsubscribeSystemResumed
  })
  const retryConnectionsNow = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    systemResumedCallback = null
    unsubscribeSystemResumed.mockClear()
    onSystemResumed.mockClear()
    retryConnectionsNow.mockClear()
    retryAllRemoteRuntimePtyRecoveriesNowMock.mockClear()
    refreshRuntimeEnvironmentStatusMock.mockClear()
    state.runtimeStatusByEnvironmentId = new Map()
    state.omitRuntimeStatusSlice = false
    vi.useFakeTimers()
    ;(window as unknown as { api: unknown }).api = {
      ui: { onSystemResumed },
      runtimeEnvironments: { retryConnectionsNow }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('advances shared-control and pane backoffs once per online or resume trigger', () => {
    const { rerender, unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())
    rerender()

    window.dispatchEvent(new Event('online'))
    systemResumedCallback?.()

    expect(retryConnectionsNow).toHaveBeenCalledTimes(2)
    expect(retryAllRemoteRuntimePtyRecoveriesNowMock).toHaveBeenCalledTimes(2)
    expect(onSystemResumed).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('removes the online listener and resume subscription on unmount', () => {
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())
    unmount()

    window.dispatchEvent(new Event('online'))

    expect(retryConnectionsNow).not.toHaveBeenCalled()
    expect(retryAllRemoteRuntimePtyRecoveriesNowMock).not.toHaveBeenCalled()
    expect(unsubscribeSystemResumed).toHaveBeenCalledTimes(1)
  })

  it('re-probes runtime hosts whose last status probe came back unreachable', async () => {
    // Why: nothing else feeds a transport that recovered on its own back into
    // runtimeStatusByEnvironmentId, so one failed boot probe used to pin a live
    // host to "disconnected" for the rest of the session (#16516).
    state.runtimeStatusByEnvironmentId.set('honey-mac', { status: null })
    state.runtimeStatusByEnvironmentId.set('openclaw', { status: { runtimeId: 'openclaw' } })
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())

    await vi.advanceTimersByTimeAsync(5_000)

    expect(refreshRuntimeEnvironmentStatusMock.mock.calls.map(([id]) => id)).toEqual(['honey-mac'])
    unmount()
  })

  it('re-probes a host whose control channel closed with an error', async () => {
    // Why: `runtimeHostConnectionState` calls this host disconnected on a *truthy* status, so a
    // private `status === null` predicate painted it red and then never retried it — the glyph
    // was terminal for the session. The recovery list must come from the same derivation.
    state.runtimeStatusByEnvironmentId.set('honey-mac', {
      status: {
        runtimeId: 'honey-mac',
        graphStatus: 'ready',
        remoteControl: { state: 'closed', lastError: 'ECONNREFUSED' }
      }
    })
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())

    await vi.advanceTimersByTimeAsync(5_000)

    expect(refreshRuntimeEnvironmentStatusMock.mock.calls.map(([id]) => id)).toEqual(['honey-mac'])
    unmount()
  })

  it('survives a store assembly without the runtime-status slice', async () => {
    state.omitRuntimeStatusSlice = true
    state.runtimeStatusByEnvironmentId.set('honey-mac', { status: null })
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())

    // Without optional chaining the sweep throws inside the timer, and the tick rejects here.
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refreshRuntimeEnvironmentStatusMock).not.toHaveBeenCalled()
    unmount()
  })

  it('stops re-probing runtime host status on unmount', async () => {
    state.runtimeStatusByEnvironmentId.set('honey-mac', { status: null })
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())
    unmount()

    await vi.advanceTimersByTimeAsync(300_000)

    expect(refreshRuntimeEnvironmentStatusMock).not.toHaveBeenCalled()
  })
})
