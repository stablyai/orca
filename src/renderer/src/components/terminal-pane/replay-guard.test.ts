import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  isPaneReplaying,
  replayIntoTerminal,
  replayIntoTerminalAsync,
  type ReplayingPanesRef
} from './replay-guard'

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

    replayIntoTerminal(pane, ref, 'slow but alive', 1_000)
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

      replayIntoTerminal(pane, ref, 'restored bytes', 1_000)
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

      replayIntoTerminal(pane, ref, 'restored bytes', 1_000)
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

  it('releases immediately when the probe write throws (terminal disposed mid-replay)', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ref = makeRef()
      const { pane, terminal } = makeFakePane(1)

      replayIntoTerminal(pane, ref, 'restored bytes', 1_000)
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

      replayIntoTerminal(pane, ref, 'lost completion', 1_000)
      replayIntoTerminal(pane, ref, 'healthy completion', 60_000)
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

    replayIntoTerminal(pane, ref, 'healthy', 1_000)
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

      const replayDone = replayIntoTerminalAsync(pane, ref, 'restored bytes', 1_000)
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
