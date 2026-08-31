// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PaneWebglCanvasDprRepairState } from '@/lib/pane-manager/terminal-canvas-dpr-repair'

const {
  recoverVisibleTerminalWindowWakeMock,
  repairPaneWebglCanvasDprMock,
  presentPaneViewportMock
} = vi.hoisted(() => ({
  recoverVisibleTerminalWindowWakeMock: vi.fn(),
  repairPaneWebglCanvasDprMock: vi.fn<() => PaneWebglCanvasDprRepairState>(() => 'current'),
  presentPaneViewportMock: vi.fn()
}))

vi.mock('./terminal-visibility-resume', () => ({
  recoverVisibleTerminalWindowWake: recoverVisibleTerminalWindowWakeMock
}))

vi.mock('@/lib/pane-manager/terminal-canvas-dpr-repair', () => ({
  repairPaneWebglCanvasDpr: repairPaneWebglCanvasDprMock
}))

vi.mock('@/lib/pane-manager/pane-webgl-renderer', () => ({
  presentPaneViewport: presentPaneViewportMock
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
    repairPaneWebglCanvasDprMock.mockClear()
    presentPaneViewportMock.mockClear()
    repairPaneWebglCanvasDprMock.mockReturnValue('current')
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

  it('preserves the glyph atlas when a fullscreen Space becomes visible', () => {
    renderWakeRecoveryHook()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })

    document.dispatchEvent(new Event('visibilitychange'))

    expect(recoverVisibleTerminalWindowWakeMock).toHaveBeenLastCalledWith({
      manager,
      isActive: true,
      clearGlyphAtlases: false
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

  it('reasserts pane PTY sizes after the window-focus fit', () => {
    const reassertPtySizeAfterWindowWake = vi.fn()
    renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef: { current: manager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true },
        panePtyBindingsRef: {
          current: new Map([[1, { dispose: vi.fn(), reassertPtySizeAfterWindowWake }]]) as never
        }
      })
    )

    window.dispatchEvent(new Event('focus'))

    expect(reassertPtySizeAfterWindowWake).toHaveBeenCalledTimes(1)
    expect(recoverVisibleTerminalWindowWakeMock.mock.invocationCallOrder[0]).toBeLessThan(
      reassertPtySizeAfterWindowWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('reasserts once after the settled fit when animation frames are available', () => {
    const scheduled: { settle: FrameRequestCallback | null } = { settle: null }
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduled.settle = callback
      return 1
    })
    const reassertPtySizeAfterWindowWake = vi.fn()
    renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef: { current: manager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true },
        panePtyBindingsRef: {
          current: new Map([[1, { dispose: vi.fn(), reassertPtySizeAfterWindowWake }]]) as never
        }
      })
    )

    window.dispatchEvent(new Event('focus'))
    expect(reassertPtySizeAfterWindowWake).not.toHaveBeenCalled()
    expect(scheduled.settle).not.toBeNull()

    scheduled.settle?.(performance.now())

    expect(reassertPtySizeAfterWindowWake).toHaveBeenCalledTimes(1)
    expect(recoverVisibleTerminalWindowWakeMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      reassertPtySizeAfterWindowWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
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

  it('repairs WebGL canvas dpr on window resize without wiping the glyph atlas', () => {
    // Chromium emits resize when devicePixelRatio changes (undock / monitor
    // move) even if the CSS box is unchanged.
    const pane = { id: 1, terminal: {} }
    const resizeManager = { getPanes: () => [pane] } as unknown as PaneManager
    repairPaneWebglCanvasDprMock.mockReturnValue('repaired')
    vi.stubGlobal('devicePixelRatio', 1)
    const { unmount } = renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef: { current: resizeManager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })
    )

    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).not.toHaveBeenCalled()

    vi.stubGlobal('devicePixelRatio', 2)
    window.dispatchEvent(new Event('resize'))

    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledWith(pane)
    expect(presentPaneViewportMock).toHaveBeenCalledWith(pane)
    expect(recoverVisibleTerminalWindowWakeMock).not.toHaveBeenCalled()

    unmount()
    vi.stubGlobal('devicePixelRatio', 3)
    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledTimes(1)
  })

  it('retains a dpr transition until the visible manager is available', () => {
    const pane = { id: 1, terminal: {} }
    const managerRef: { current: PaneManager | null } = { current: null }
    vi.stubGlobal('devicePixelRatio', 1)
    renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef,
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })
    )

    vi.stubGlobal('devicePixelRatio', 2)
    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).not.toHaveBeenCalled()

    managerRef.current = { getPanes: () => [pane] } as unknown as PaneManager
    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledWith(pane)
  })

  it('deduplicates a deferred dpr retry and consumes it after repair succeeds', () => {
    const pane = { id: 1, terminal: {} }
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    vi.stubGlobal('devicePixelRatio', 1)
    repairPaneWebglCanvasDprMock.mockReturnValueOnce('deferred').mockReturnValue('repaired')
    renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef: { current: { getPanes: () => [pane] } as unknown as PaneManager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })
    )

    vi.stubGlobal('devicePixelRatio', 2)
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledTimes(1)
    expect(callbacks).toHaveLength(1)

    callbacks.shift()?.(performance.now())
    expect(presentPaneViewportMock).toHaveBeenCalledWith(pane)
    window.dispatchEvent(new Event('resize'))
    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledTimes(2)
  })

  it('caps a deferred dpr transition at sixteen animation-frame retries', () => {
    const pane = { id: 1, terminal: {} }
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    vi.stubGlobal('devicePixelRatio', 1)
    repairPaneWebglCanvasDprMock.mockReturnValue('deferred')
    renderHook(() =>
      useTerminalWindowWakeRecovery({
        isVisible: true,
        managerRef: { current: { getPanes: () => [pane] } as unknown as PaneManager },
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })
    )

    vi.stubGlobal('devicePixelRatio', 2)
    window.dispatchEvent(new Event('resize'))
    let callbackCount = 0
    while (callbacks.length > 0) {
      callbacks.shift()?.(performance.now())
      callbackCount += 1
    }

    expect(callbackCount).toBe(16)
    expect(repairPaneWebglCanvasDprMock).toHaveBeenCalledTimes(17)
  })
})
