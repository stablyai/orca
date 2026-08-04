import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import {
  resetTerminalWebglAtlasRecoveryBudgetForTesting,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleTabRevealWebglAtlasRecovery,
  scheduleTerminalWebglAtlasRecovery,
  TERMINAL_OUTPUT_RECOVERY_QUIET_MS
} from './terminal-webgl-atlas-recovery'

describe('terminal WebGL atlas recovery', () => {
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager(): {
    resetWebglTextureAtlases: Mock<() => void>
    refreshAllPanes: Mock<() => void>
    scheduleRevealPresent: Mock<() => void>
  } {
    const manager = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>(),
      scheduleRevealPresent: vi.fn<() => void>()
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    // Why: a test can leave the module-global debounce timer armed; clear the
    // fake-timer queue before restoring real timers so no pending fire leaks
    // into a later test.
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetTerminalWebglAtlasRecoveryBudgetForTesting()
  })

  it('clears atlases and refreshes panes through the post-paste redraw window', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    // Why: resets go through the live-manager registry so every terminal
    // sharing the glyph atlas rebuilds and repaints, not just the paste target.
    const manager = registerManager()
    const otherManager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    rafCallbacks[0]?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(otherManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(otherManager.refreshAllPanes).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(120)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)
  })

  it('refreshes after each scheduled atlas reset', () => {
    vi.useFakeTimers()
    const order: string[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('first-reset')),
      refreshAllPanes: vi.fn(() => order.push('first-refresh'))
    }
    const otherManager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('second-reset')),
      refreshAllPanes: vi.fn(() => order.push('second-refresh'))
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    registerLivePaneManager(otherManager)
    registeredManagers.push(otherManager)

    scheduleImagePasteWebglAtlasRecovery()
    vi.advanceTimersByTime(500)

    expect(order).toEqual([
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh',
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh',
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh'
    ])
  })

  it('falls back to a timeout when animation frames are unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const manager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('continues recovery when a manager throws after scheduling', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn()
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    const healthyManager = registerManager()

    expect(() => scheduleImagePasteWebglAtlasRecovery()).not.toThrow()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(healthyManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(healthyManager.refreshAllPanes).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('recovers immediately on a tab reveal, not through the streaming debounce', () => {
    // Regression guard (STA-1365 review): reveal recovery must stay immediate so a
    // background agent streaming in another pane cannot defer a revealed tab's
    // atlas rebuild. It shares the paste path's immediate burst, not the debounce.
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    const manager = registerManager()

    scheduleTabRevealWebglAtlasRecovery()
    // First burst leg fires on the next frame — no 200ms debounce wait.
    rafCallbacks[0]?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)
  })

  it('does not recover mid-stream while terminal output keeps arriving', () => {
    // Regression (STA-1365): an alternate-screen TUI requests atlas recovery on
    // every redraw frame. Recovering mid-stream clears the shared glyph atlas and
    // repaints every pane several times a second, which reads as a flicker. The
    // debounce must swallow a sustained stream entirely until it goes quiet.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    // Simulate ~1s of continuous streaming: a redraw chunk every 50ms, each
    // shorter than the quiet window, so the debounce keeps resetting.
    for (let elapsed = 0; elapsed < 1000; elapsed += 50) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(50)
    }

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('recovers exactly once after terminal output settles, not a 3-stage burst', () => {
    // Brennan-approved single-recovery decision: the streaming settle fires one
    // clear+refresh, not the rAF+120+500 burst, so a clear can only ever land
    // after 200ms of global quiet. Advancing past the burst delays must add no
    // further fires on the streaming path.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    scheduleTerminalWebglAtlasRecovery()
    scheduleTerminalWebglAtlasRecovery()

    // Still nothing before the quiet window elapses.
    vi.advanceTimersByTime(199)
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()

    // Quiet window elapsed → exactly one clear+refresh for the coalesced stream.
    vi.advanceTimersByTime(1)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)

    // The 120ms/500ms burst legs must NOT fire on the streaming path.
    vi.advanceTimersByTime(120)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('does not clear mid-stream when a settle is followed by resumed streaming', () => {
    // Cancelable invariant (STA-1365): a stream that pauses just over the quiet
    // window lets the settle fire its single recovery during the gap, but the
    // resumed chunks must not trigger any further clear while they keep arriving
    // <200ms apart — the re-arm cancels the only pending handle (the debounce
    // timer), so no clear lands mid-resumed-stream.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    // Initial stream, then a gap just over the quiet window → one settle recovery.
    for (let elapsed = 0; elapsed < 300; elapsed += 50) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(50)
    }
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)

    // Resume streaming: fire-count must stay pinned while chunks keep arriving.
    for (let elapsed = 0; elapsed < 1000; elapsed += 50) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(50)
      expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
      expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    }
  })

  it('caps shared-atlas wipes under a sustained alt-screen redraw cadence', () => {
    // Field regression (F0BMLFAFWF7 on 1.4.167): 442 full shared-glyph-atlas
    // wipes in 6.2 minutes. A TUI redrawing just slower than the quiet window
    // clears the debounce on every parse, so the trailing edge fires each time
    // — the debounce bounds nothing at this cadence.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    for (let elapsed = 0; elapsed < 60_000; elapsed += 300) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(300)
    }

    expect(manager.resetWebglTextureAtlases.mock.calls.length).toBeLessThanOrEqual(30)
  })

  it('keeps the wipe gap bounded under a sustained redraw cadence, not burst-then-starve', () => {
    // Review regression: a fixed count over a rolling 60s window spends its whole
    // allowance in the first 30s and then starves for 33s. The over-budget path
    // only re-presents the buffers — it never rebuilds the glyph atlas — so a
    // vim-style rewrite stayed garbled for half a minute. The refill must be
    // continuous so the worst-case gap degrades to the refill interval.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const wipeTimes: number[] = []
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => wipeTimes.push(Date.now())),
      refreshAllPanes: vi.fn(),
      scheduleRevealPresent: vi.fn()
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)

    // Five minutes of the field cadence (F0BMLFAFWF7 ran ~1 redraw/s for hours).
    for (let elapsed = 0; elapsed < 300_000; elapsed += 300) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(300)
    }

    const gaps = wipeTimes.slice(1).map((at, index) => at - wipeTimes[index]!)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6_500)
    // Still a large cut from the unbounded ~200 wipes/min the debounce allowed.
    expect(wipeTimes.length).toBeLessThanOrEqual(75)
  })

  it('presents from the live buffers when a settle is over the wipe budget', () => {
    // De-escalation: a suppressed settle must still recover stale pixels, just
    // without wiping the atlas shared by every same-config terminal.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).not.toHaveBeenCalled()

    // Second settle lands inside the minimum interval → present, no wipe.
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
  })

  it('recovers the wipe budget when the wall clock steps backwards', () => {
    // Sleep/resume, NTP correction and SSH host-clock skew can move Date.now()
    // backwards; the bucket must not wedge until the clock catches up.
    vi.useFakeTimers()
    vi.setSystemTime(600_000)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)

    vi.setSystemTime(60_000)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
  })

  it('keeps paste and reveal recovery immediate after the streaming budget is spent', () => {
    // Reveal/paste are one-shot user-visible events; the streaming rate cap must
    // never defer or downgrade them.
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    for (let elapsed = 0; elapsed < 60_000; elapsed += 300) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(300)
    }
    manager.resetWebglTextureAtlases.mockClear()
    manager.refreshAllPanes.mockClear()

    scheduleTabRevealWebglAtlasRecovery()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)

    manager.resetWebglTextureAtlases.mockClear()
    scheduleImagePasteWebglAtlasRecovery()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
  })

  it('coalesces the terminal-output callers onto one shared timer while paste stays immediate', () => {
    // Cross-caller single-timer invariant: the terminal-output re-arm sites
    // (foreground and hidden-output PTY writes) funnel through
    // scheduleTerminalWebglAtlasRecovery and re-arm the one module-global debounce
    // timer, so a single continuous stream (even a hidden one) keeps the recovery
    // deferred for everyone. Image paste and tab reveal use their own immediate
    // burst and are not coupled to the shared debounce timer.
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    const manager = registerManager()

    // The terminal-output re-arm sites (foreground / hidden-output) both funnel
    // through this one function; none may fire mid-stream.
    for (let elapsed = 0; elapsed < 600; elapsed += 50) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(50)
    }
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()

    // Global quiet → exactly one coalesced recovery for the whole shared stream.
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)

    // Paste is independent: its own immediate 3-stage burst, not the shared timer.
    manager.resetWebglTextureAtlases.mockClear()
    manager.refreshAllPanes.mockClear()
    scheduleImagePasteWebglAtlasRecovery()
    rafCallbacks.at(-1)?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)
  })
})
