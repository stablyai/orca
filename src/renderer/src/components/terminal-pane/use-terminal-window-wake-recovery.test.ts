// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

const { recoverVisibleTerminalWindowWakeMock } = vi.hoisted(() => ({
  recoverVisibleTerminalWindowWakeMock: vi.fn()
}))

vi.mock('./terminal-visibility-resume', () => ({
  recoverVisibleTerminalWindowWake: recoverVisibleTerminalWindowWakeMock
}))

import { useTerminalWindowWakeRecovery } from './use-terminal-window-wake-recovery'

describe('useTerminalWindowWakeRecovery', () => {
  const manager = {} as PaneManager
  let systemResumedCallback: (() => void) | null = null
  const unsubscribeSystemResumed = vi.fn()
  const onSystemResumed = vi.fn((callback: () => void) => {
    systemResumedCallback = callback
    return unsubscribeSystemResumed
  })

  beforeEach(() => {
    systemResumedCallback = null
    recoverVisibleTerminalWindowWakeMock.mockClear()
    unsubscribeSystemResumed.mockClear()
    onSystemResumed.mockClear()
    // Why: without requestAnimationFrame the hook skips its settled-frame
    // follow-up, so every trigger maps to exactly one synchronous recovery.
    vi.stubGlobal('requestAnimationFrame', undefined)
    ;(window as unknown as { api: unknown }).api = { ui: { onSystemResumed } }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { api?: unknown }).api
  })

  function renderWakeRecoveryHook(isVisible = true) {
    return renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible,
        managerRef: { current: manager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })
    )
  }

  it('runs the same wake recovery for system resume as for window focus', () => {
    renderWakeRecoveryHook()

    window.dispatchEvent(new Event('focus'))
    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenCalledTimes(1)

    expect(systemResumedCallback).toBeTypeOf('function')
    systemResumedCallback?.()

    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenCalledTimes(2)
    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenNthCalledWith(2, {
      manager,
      isActive: true
    })
    expect(recoverVisibleTerminalWindowWakeMock.mock.calls[1]).toEqual(
      recoverVisibleTerminalWindowWakeMock.mock.calls[0]
    )
  })

  it('unsubscribes from the system resume event on cleanup', () => {
    const { unmount } = renderWakeRecoveryHook()
    expect(onSystemResumed).toHaveBeenCalledTimes(1)

    unmount()

    expect(unsubscribeSystemResumed).toHaveBeenCalledTimes(1)
  })

  it('does not subscribe while the terminal surface is hidden', () => {
    renderWakeRecoveryHook(false)

    expect(onSystemResumed).not.toHaveBeenCalled()
  })
})
