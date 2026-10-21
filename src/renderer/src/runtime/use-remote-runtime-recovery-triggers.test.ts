// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const { retryAllRemoteRuntimePtyRecoveriesNowMock, reviveForEnvironmentMock } = vi.hoisted(() => ({
  retryAllRemoteRuntimePtyRecoveriesNowMock: vi.fn(),
  reviveForEnvironmentMock: vi.fn()
}))

vi.mock('@/components/terminal-pane/remote-runtime-pty-recovery-state', () => ({
  retryAllRemoteRuntimePtyRecoveriesNow: retryAllRemoteRuntimePtyRecoveriesNowMock,
  reviveRemoteRuntimePtyRecoveriesForEnvironment: reviveForEnvironmentMock
}))

type DiagnosticsEvent = { environmentId: string; diagnostics: { state: string } }

import { useRemoteRuntimeRecoveryTriggers } from './use-remote-runtime-recovery-triggers'

describe('useRemoteRuntimeRecoveryTriggers', () => {
  let systemResumedCallback: (() => void) | null = null
  const unsubscribeSystemResumed = vi.fn()
  const onSystemResumed = vi.fn((callback: () => void) => {
    systemResumedCallback = callback
    return unsubscribeSystemResumed
  })
  const retryConnectionsNow = vi.fn(() => Promise.resolve())
  let diagnosticsCallback: ((event: DiagnosticsEvent) => void) | null = null
  const unsubscribeDiagnostics = vi.fn()
  const onSharedControlDiagnostics = vi.fn((callback: (event: DiagnosticsEvent) => void) => {
    diagnosticsCallback = callback
    return unsubscribeDiagnostics
  })
  const emitState = (environmentId: string, state: string): void =>
    diagnosticsCallback?.({ environmentId, diagnostics: { state } })

  beforeEach(() => {
    systemResumedCallback = null
    unsubscribeSystemResumed.mockClear()
    onSystemResumed.mockClear()
    retryConnectionsNow.mockClear()
    retryAllRemoteRuntimePtyRecoveriesNowMock.mockClear()
    reviveForEnvironmentMock.mockClear()
    diagnosticsCallback = null
    unsubscribeDiagnostics.mockClear()
    ;(window as unknown as { api: unknown }).api = {
      ui: { onSystemResumed },
      runtimeEnvironments: { retryConnectionsNow, onSharedControlDiagnostics }
    }
  })

  afterEach(() => {
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

  // #9092/#25783: a returning Tailscale or VPN route fires no `online`, so the control socket is the signal.
  it("revives an environment's panes when its control connection becomes ready again", () => {
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())

    emitState('env-1', 'ready')
    emitState('env-1', 'ready')
    expect(reviveForEnvironmentMock.mock.calls).toEqual([['env-1']])

    emitState('env-1', 'reconnecting')
    emitState('env-2', 'connecting')
    expect(reviveForEnvironmentMock).toHaveBeenCalledTimes(1)

    emitState('env-1', 'ready')
    expect(reviveForEnvironmentMock.mock.calls).toEqual([['env-1'], ['env-1']])
    unmount()
    expect(unsubscribeDiagnostics).toHaveBeenCalledTimes(1)
  })
})
