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
import {
  getTerminalFreezeBreadcrumbs,
  resetTerminalFreezeBreadcrumbsForTesting
} from './terminal-freeze-breadcrumbs'

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
    resetTerminalFreezeBreadcrumbsForTesting()
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

  it('clears the glyph atlas on system resume but not on plain window focus', () => {
    // Why: wiping the shared WebGL glyph atlas on a plain refocus provokes
    // xterm's page-merge race and paints garbled glyphs (#7604). Only a genuine
    // OS resume — which can leave a stale renderer surface — clears the atlas.
    renderWakeRecoveryHook()

    window.dispatchEvent(new Event('focus'))
    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenCalledTimes(1)
    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenNthCalledWith(1, {
      manager,
      isActive: true,
      clearGlyphAtlases: false
    })

    expect(systemResumedCallback).toBeTypeOf('function')
    systemResumedCallback?.()

    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenCalledTimes(2)
    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenNthCalledWith(2, {
      manager,
      isActive: true,
      clearGlyphAtlases: true
    })
  })

  it('records a wake-recovery breadcrumb with the trigger source and atlas decision', () => {
    // Why: a post-wake garble report attributes to the trigger that ran (or its
    // absence). Pin that focus records source=focus/atlas=false and system
    // resume records source=system-resumed/atlas=true.
    renderWakeRecoveryHook()

    window.dispatchEvent(new Event('focus'))
    systemResumedCallback?.()

    const wakeCrumbs = getTerminalFreezeBreadcrumbs().filter((crumb) =>
      crumb.kind.startsWith('wake-recovery:')
    )
    expect(wakeCrumbs.map((crumb) => [crumb.kind, crumb.detail])).toEqual([
      ['wake-recovery:focus', { clearGlyphAtlases: false }],
      ['wake-recovery:system-resumed', { clearGlyphAtlases: true }]
    ])
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
