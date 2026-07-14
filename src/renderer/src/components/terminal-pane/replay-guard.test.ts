import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  isPaneReplaying,
  replayIntoTerminal,
  replayIntoTerminalAsync,
  type ReplayingPanesRef
} from './replay-guard'
import { configureLazyArabicShapingJoiner } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'
import {
  _resetWritePipelineHealthForTests,
  captureTerminalParseProgressGeneration,
  hasTerminalParseProgressSince,
  notifyUndeliverableWrite,
  registerUndeliverableWriteHandler
} from '@/lib/pane-manager/terminal-write-pipeline-health'

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  mocks.recordRendererCrashBreadcrumb.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeRef(): ReplayingPanesRef {
  return { current: new Map() } as ReplayingPanesRef
}

type FakeTerminal = {
  write: (data: string, cb?: () => void) => void
  lastData: string[]
  pendingCallbacks: (() => void)[]
  rows: number
  buffer: {
    active: {
      baseY: number
      viewportY: number
    }
  }
  _core: {
    refresh: (start: number, end: number, sync?: boolean) => void
  }
  refresh: (start: number, end: number) => void
  /** Flush all pending xterm write callbacks, simulating parse completion. */
  flush: () => void
}

function makeFakePane(paneId: number): { pane: ManagedPane; terminal: FakeTerminal } {
  const pendingCallbacks: (() => void)[] = []
  const terminal: FakeTerminal = {
    lastData: [],
    pendingCallbacks,
    rows: 24,
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0
      }
    },
    _core: {
      refresh() {}
    },
    refresh() {},
    write(data: string, cb?: () => void) {
      terminal.lastData.push(data)
      if (cb) {
        pendingCallbacks.push(cb)
      }
    },
    flush() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()!()
      }
    }
  }
  // Only `id` and `terminal` are exercised by replayIntoTerminal.
  const pane = { id: paneId, terminal } as unknown as ManagedPane
  return { pane, terminal }
}

describe('replay-guard', () => {
  it('reports no replay for untouched pane', () => {
    const ref = makeRef()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('registers Arabic shaping before replay bytes are written', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    const events: string[] = []
    const joinerTerminal = terminal as FakeTerminal & {
      registerCharacterJoiner: (handler: (text: string) => [number, number][]) => number
      deregisterCharacterJoiner: (joinerId: number) => void
    }
    joinerTerminal.registerCharacterJoiner = () => {
      events.push('register')
      return 5
    }
    joinerTerminal.deregisterCharacterJoiner = () => undefined
    terminal.write = (data: string, callback?: () => void) => {
      events.push(`write:${data}`)
      if (callback) {
        terminal.pendingCallbacks.push(callback)
      }
    }
    const cleanup = configureLazyArabicShapingJoiner(joinerTerminal as never, () => true)

    replayIntoTerminal(pane, ref, 'مرحبا')

    expect(events).toEqual(['register', 'write:مرحبا'])
    cleanup()
  })

  it('still replays RTL bytes when joiner registration fails', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    const joinerTerminal = terminal as FakeTerminal & {
      registerCharacterJoiner: () => number
      deregisterCharacterJoiner: () => void
    }
    joinerTerminal.registerCharacterJoiner = () => {
      throw new Error('terminal disposed')
    }
    joinerTerminal.deregisterCharacterJoiner = () => undefined
    configureLazyArabicShapingJoiner(joinerTerminal as never, () => true)

    replayIntoTerminal(pane, ref, 'مرحبا')

    expect(terminal.lastData).toEqual(['مرحبا'])
    terminal.flush()
    expect(isPaneReplaying(ref, pane.id)).toBe(false)
  })

  it('is replaying between write dispatch and xterm parse completion', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    replayIntoTerminal(pane, ref, 'hello')

    // Before xterm fires its write-completion callback, the guard is engaged —
    // this is the window during which xterm could emit auto-replies for any
    // query sequences embedded in the replayed data.
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('composes nested replays via a counter', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    // Simulates the cold-restore path: clear preamble + scrollback + banner
    // dispatched back-to-back before xterm completes any of them.
    replayIntoTerminal(pane, ref, '\x1b[2J\x1b[3J\x1b[H')
    replayIntoTerminal(pane, ref, 'scrollback bytes')
    replayIntoTerminal(pane, ref, '--- session restored ---')
    expect(isPaneReplaying(ref, 1)).toBe(true)

    // Completion of the first write must not clear the guard — the later
    // writes are still in xterm's queue and may still auto-reply.
    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.pendingCallbacks.shift()!()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('keeps each pane independent', () => {
    const ref = makeRef()
    const a = makeFakePane(1)
    const b = makeFakePane(2)

    replayIntoTerminal(a.pane, ref, 'a')
    expect(isPaneReplaying(ref, 1)).toBe(true)
    expect(isPaneReplaying(ref, 2)).toBe(false)

    replayIntoTerminal(b.pane, ref, 'b')
    expect(isPaneReplaying(ref, 2)).toBe(true)

    a.terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
    expect(isPaneReplaying(ref, 2)).toBe(true)

    b.terminal.flush()
    expect(isPaneReplaying(ref, 2)).toBe(false)
  })

  it('skips empty data without touching the guard or xterm', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    replayIntoTerminal(pane, ref, '')
    expect(terminal.lastData).toEqual([])
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('removes the counter entry when the last replay completes', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    replayIntoTerminal(pane, ref, 'x')
    terminal.flush()
    expect(ref.current.has(1)).toBe(false)
  })

  it('auto-releases the guard when xterm never fires the parse callback', () => {
    // Repro of the cold-restore reattach lockout (main #7661):
    // handleReattachResult replays three chunks into a just-mounted /
    // offscreen pane whose terminal never flushes, so xterm's parse callback
    // never runs and the counter would stay pinned at 3 — isPaneReplaying()
    // stuck true drops EVERY keystroke. The probe-certified stall path (probe
    // never parses either => wedged release) must free the guard.
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)
      replayIntoTerminal(pane, ref, '\x1b[2J\x1b[3J\x1b[H', { stallCheckMs: 400 })
      replayIntoTerminal(pane, ref, 'scrollback bytes', { stallCheckMs: 400 })
      replayIntoTerminal(pane, ref, '--- session restored ---', { stallCheckMs: 400 })
      expect(isPaneReplaying(ref, 1)).toBe(true)

      // Never flush — the probe write never parses; the wedged release fires
      // one stall window after the probe (400 + 400).
      vi.advanceTimersByTime(1000)

      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(ref.current.has(1)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a wedged release hands the terminal to pane recovery', () => {
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)
      const onUndeliverable = vi.fn()
      registerUndeliverableWriteHandler(pane.terminal, onUndeliverable)

      replayIntoTerminal(pane, ref, 'fossil frame bytes', { stallCheckMs: 400 })
      // Never flush: probe never parses → wedged release.
      vi.advanceTimersByTime(1000)

      expect(onUndeliverable).toHaveBeenCalledTimes(1)
      expect(onUndeliverable).toHaveBeenCalledWith('replay-wedged')
      _resetWritePipelineHealthForTests(pane.terminal)
    } finally {
      vi.useRealTimers()
    }
  })

  it('short-circuits replays into a certified-dead terminal', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    notifyUndeliverableWrite(pane.terminal, 'write-stalled')

    replayIntoTerminal(pane, ref, 'zombie restore bytes')

    // No write reaches the dead pipeline and no guard is engaged — the
    // watchdog-driven restore loop can no longer produce the wedged drip.
    expect(terminal.lastData).toHaveLength(0)
    expect(isPaneReplaying(ref, 1)).toBe(false)
    _resetWritePipelineHealthForTests(pane.terminal)
  })

  it('resolves async replays into a certified-dead terminal without writing', async () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    notifyUndeliverableWrite(pane.terminal, 'replay-wedged')

    await replayIntoTerminalAsync(pane, ref, 'zombie restore bytes')

    expect(terminal.lastData).toHaveLength(0)
    expect(isPaneReplaying(ref, 1)).toBe(false)
    _resetWritePipelineHealthForTests(pane.terminal)
  })

  it('a healthy parse completion never notifies pane recovery', () => {
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)
      const onUndeliverable = vi.fn()
      registerUndeliverableWriteHandler(pane.terminal, onUndeliverable)

      replayIntoTerminal(pane, ref, 'healthy bytes', { stallCheckMs: 400 })
      terminal.flush()
      vi.advanceTimersByTime(1000)

      expect(onUndeliverable).not.toHaveBeenCalled()
      _resetWritePipelineHealthForTests(pane.terminal)
    } finally {
      vi.useRealTimers()
    }
  })

  it('parse completion cancels the stall probe without over-releasing', () => {
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)
      replayIntoTerminal(pane, ref, 'a', { stallCheckMs: 400 })
      replayIntoTerminal(pane, ref, 'b', { stallCheckMs: 400 })

      terminal.flush()
      expect(isPaneReplaying(ref, 1)).toBe(false)

      // The already-cancelled stall timer must not fire and underflow the counter.
      vi.advanceTimersByTime(1000)
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(ref.current.has(1)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('async replay resolves even when the parse callback never fires', async () => {
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)
      let resolved = false
      const promise = replayIntoTerminalAsync(pane, ref, 'x', { stallCheckMs: 400 }).then(() => {
        resolved = true
      })
      expect(isPaneReplaying(ref, 1)).toBe(true)

      await vi.advanceTimersByTimeAsync(1000)
      await promise

      expect(resolved).toBe(true)
      expect(isPaneReplaying(ref, 1)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules a follow-up repaint for replayed cursor restores', () => {
    const scheduledFrames: FrameRequestCallback[] = []
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame

    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)
      let refreshCount = 0
      terminal._core.refresh = () => {
        refreshCount += 1
      }

      replayIntoTerminal(pane, ref, '\x1b[?25h')
      terminal.flush()

      expect(refreshCount).toBe(1)
      expect(scheduledFrames).toHaveLength(1)

      scheduledFrames[0]?.(16)

      expect(refreshCount).toBe(2)
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })

  it('coalesces WebGL replay refreshes and rechecks before the follow-up', () => {
    const scheduledFrames: FrameRequestCallback[] = []
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame

    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)
      const synchronousRefresh = vi.fn()
      const debouncedRefresh = vi.fn()
      terminal._core.refresh = synchronousRefresh
      terminal.refresh = debouncedRefresh
      let webglLive = true

      replayIntoTerminal(pane, ref, 'snapshot bytes', {
        shouldRefreshViewportSynchronously: () => !webglLive
      })
      terminal.flush()

      expect(debouncedRefresh).toHaveBeenCalledWith(0, 23)
      expect(synchronousRefresh).not.toHaveBeenCalled()
      webglLive = false
      scheduledFrames[0]?.(16)

      expect(synchronousRefresh).toHaveBeenCalledWith(0, 23, true)
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })
})

describe('replay-guard stall handling (probe-certified release)', () => {
  it('HOLDS the guard while a slow replay is still parsing — a probe is queued, never a blind release', () => {
    // Why this is the load-bearing safety test: a time-based release here
    // would leak xterm auto-replies into the shell (and a leaked ESC into an
    // agent TUI reads as the user pressing Escape). The guard must only
    // release when the pipeline itself proves the replay parsed.
    vi.useFakeTimers()
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    replayIntoTerminal(pane, ref, 'slow but alive', { stallCheckMs: 1_000 })
    expect(isPaneReplaying(ref, 1)).toBe(true)

    // Stall check fires: an empty probe write is enqueued behind the replay.
    vi.advanceTimersByTime(1_000)
    expect(terminal.lastData).toEqual(['slow but alive', ''])
    // Probe is pending → replay genuinely still parsing → guard holds.
    expect(isPaneReplaying(ref, 1)).toBe(true)
    vi.advanceTimersByTime(999)
    expect(isPaneReplaying(ref, 1)).toBe(true)

    // Parsing finishes: FIFO runs the replay completion first (normal
    // release), then the probe completion as a no-op.
    terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
    expect(ref.current.has(1)).toBe(false)
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()

    vi.advanceTimersByTime(120_000)
    expect(ref.current.has(1)).toBe(false)
  })

  it('releases when the probe parses but the replay completion was lost, and reports it', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)

      replayIntoTerminal(pane, ref, 'restored bytes', { stallCheckMs: 1_000 })
      terminal.pendingCallbacks.shift() // xterm lost the replay's completion
      vi.advanceTimersByTime(1_000) // stall check → probe enqueued

      // The probe's completion firing certifies every earlier replay byte
      // parsed — releasing now cannot leak auto-replies.
      terminal.flush()
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_replay_guard_lost_completion',
        { paneId: 1 }
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('releases after the probe itself never parses (wedged pipeline) and reports it', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)

      replayIntoTerminal(pane, ref, 'restored bytes', { stallCheckMs: 1_000 })
      vi.advanceTimersByTime(1_000) // stall check → probe enqueued
      expect(isPaneReplaying(ref, 1)).toBe(true)

      // A wedged parser will never run the probe callback — and can never
      // emit auto-replies either, so this bounded release cannot leak input.
      vi.advanceTimersByTime(1_000)
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_replay_guard_wedged_release',
        { paneId: 1 }
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('holds past the probe deadline while sibling completions prove the parser alive', () => {
    // Production shape (wedge-release breadcrumbs in bursts of ~a dozen on a
    // pane that later parses fine): a hidden-restore loop queues several
    // replay writes and xterm's FIFO parse falls behind by more than two
    // probe windows while still completing writes. Certifying that as wedged
    // opens the guard mid-parse (auto-reply leak) and remounts a live pane.
    vi.useFakeTimers()
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    const recoveryReasons: string[] = []
    const unregister = registerUndeliverableWriteHandler(terminal, (reason) => {
      recoveryReasons.push(reason)
    })
    try {
      replayIntoTerminal(pane, ref, 'chunk-A', { stallCheckMs: 1_000 })
      vi.advanceTimersByTime(500)
      replayIntoTerminal(pane, ref, 'chunk-B', { stallCheckMs: 1_000 })

      // t=1000: A's probe queued. t=1500: B's probe queued.
      vi.advanceTimersByTime(1_100)
      // t=1600: A's completion parses — the pipeline is alive, just behind.
      terminal.pendingCallbacks.shift()!()
      expect(isPaneReplaying(ref, 1)).toBe(true)

      // t=2500: B's probe deadline fires with A's completion inside the
      // window. Progress means "behind", not "wedged" — the guard HOLDS.
      vi.advanceTimersByTime(900)
      expect(isPaneReplaying(ref, 1)).toBe(true)
      expect(recoveryReasons).toEqual([])
      expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()

      // Parse catches up: FIFO releases B as parsed, probes are no-ops.
      terminal.flush()
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(ref.current.has(1)).toBe(false)
      expect(recoveryReasons).toEqual([])
      expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
    } finally {
      unregister()
      _resetWritePipelineHealthForTests(terminal)
    }
  })

  it('still certifies a wedge after progress stops for a full probe window', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    const recoveryReasons: string[] = []
    const unregister = registerUndeliverableWriteHandler(terminal, (reason) => {
      recoveryReasons.push(reason)
    })
    try {
      replayIntoTerminal(pane, ref, 'chunk-A', { stallCheckMs: 1_000 })
      replayIntoTerminal(pane, ref, 'chunk-B', { stallCheckMs: 1_000 })

      // t=1000: both probes queued. t=1100: A completes, then silence.
      vi.advanceTimersByTime(1_100)
      terminal.pendingCallbacks.shift()!()

      // t=2000: B's deadline sees A's progress → extends one quiet window.
      vi.advanceTimersByTime(900)
      expect(isPaneReplaying(ref, 1)).toBe(true)
      expect(recoveryReasons).toEqual([])

      // t=3000: the extended window passed with zero progress → wedged.
      vi.advanceTimersByTime(1_000)
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(recoveryReasons).toEqual(['replay-wedged'])
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_replay_guard_wedged_release',
        { paneId: 1 }
      )
    } finally {
      unregister()
      _resetWritePipelineHealthForTests(terminal)
      errorSpy.mockRestore()
    }
  })

  it('recovers an immediately rejected replay without recording parse progress', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)
    const recoveryReasons: string[] = []
    const generation = captureTerminalParseProgressGeneration(terminal)
    const unregister = registerUndeliverableWriteHandler(terminal, (reason) => {
      recoveryReasons.push(reason)
    })
    terminal.write = () => {
      throw new Error('terminal disposed')
    }
    try {
      replayIntoTerminal(pane, ref, 'rejected replay')

      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(hasTerminalParseProgressSince(terminal, generation)).toBe(false)
      expect(recoveryReasons).toEqual(['replay-wedged'])
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_replay_guard_wedged_release',
        { paneId: 1 }
      )
    } finally {
      unregister()
      _resetWritePipelineHealthForTests(terminal)
      errorSpy.mockRestore()
    }
  })

  it('releases immediately when the probe write throws (terminal disposed mid-replay)', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)

      replayIntoTerminal(pane, ref, 'restored bytes', { stallCheckMs: 1_000 })
      terminal.write = () => {
        throw new Error('terminal disposed')
      }
      vi.advanceTimersByTime(1_000)
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
        'terminal_replay_guard_wedged_release',
        { paneId: 1 }
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps overlapping engagements independent through a lost completion', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)

      replayIntoTerminal(pane, ref, 'lost completion', { stallCheckMs: 1_000 })
      replayIntoTerminal(pane, ref, 'healthy completion', { stallCheckMs: 60_000 })
      terminal.pendingCallbacks.shift() // drop only the first completion
      vi.advanceTimersByTime(1_000) // first engagement's probe enqueued

      terminal.flush() // healthy completion + probe both parse
      expect(isPaneReplaying(ref, 1)).toBe(false)
      expect(ref.current.has(1)).toBe(false)

      vi.advanceTimersByTime(120_000)
      expect(ref.current.has(1)).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('never probes after a normal completion', () => {
    vi.useFakeTimers()
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    replayIntoTerminal(pane, ref, 'healthy', { stallCheckMs: 1_000 })
    terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)

    vi.advanceTimersByTime(60_000)
    expect(terminal.lastData).toEqual(['healthy'])
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('resolves replayIntoTerminalAsync via the wedged path so restore chains cannot hang', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)

      const replayDone = replayIntoTerminalAsync(pane, ref, 'restored bytes', {
        stallCheckMs: 1_000
      })
      let resolved = false
      void replayDone.then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(2_000)
      expect(resolved).toBe(true)
      expect(isPaneReplaying(ref, 1)).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
