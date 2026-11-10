import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import '@/lib/pane-manager/pane-lifecycle'
import {
  isPaneReplaying,
  replayIntoTerminal,
  replayIntoTerminalAsync,
  waitForTerminalReplayWritesParsed,
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

vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
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
    // Private flag read by isXtermInstanceDisposed.
    _store?: { _isDisposed: boolean }
  }
  refresh: (start: number, end: number) => void
  /** Like xterm 6: drops queued write callbacks and flags the private store. */
  dispose: () => void
  /** Flush all pending xterm write callbacks, simulating parse completion. */
  flush: () => void
}

function makeFakePane(paneId: number): { pane: ManagedPaneInternal; terminal: FakeTerminal } {
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
    dispose() {
      pendingCallbacks.length = 0
      terminal._core._store = { _isDisposed: true }
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replay reads only id/terminal; disposePane null-checks or try-wraps every other field it touches.
  const pane = { id: paneId, terminal } as unknown as ManagedPaneInternal
  return { pane, terminal }
}

describe('replay-guard', () => {
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

    // Keep the guard until parse completion so replay queries cannot emit shell input.
    expect(isPaneReplaying(ref, 1)).toBe(true)

    terminal.flush()
    expect(isPaneReplaying(ref, 1)).toBe(false)
  })

  it('composes nested replays via a counter', () => {
    const ref = makeRef()
    const { pane, terminal } = makeFakePane(1)

    // Queue cold-restore preamble, history and banner before any parse completion.
    replayIntoTerminal(pane, ref, '\x1b[2J\x1b[3J\x1b[H')
    replayIntoTerminal(pane, ref, 'scrollback bytes')
    replayIntoTerminal(pane, ref, '--- session restored ---')
    expect(isPaneReplaying(ref, 1)).toBe(true)

    // The first completion cannot release later queued replay writes that may still auto-reply.
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

  it('auto-releases the guard when xterm never fires the parse callback', () => {
    // Lost parse completions can pin every replay counter and eat input; a probe-certified quiet wedge must release them (#7661).
    vi.useFakeTimers()
    try {
      const ref = makeRef()
      const { pane } = makeFakePane(1)
      replayIntoTerminal(pane, ref, '\x1b[2J\x1b[3J\x1b[H', { stallCheckMs: 400 })
      replayIntoTerminal(pane, ref, 'scrollback bytes', { stallCheckMs: 400 })
      replayIntoTerminal(pane, ref, '--- session restored ---', { stallCheckMs: 400 })
      expect(isPaneReplaying(ref, 1)).toBe(true)

      // Never parse replay or probe; release only after both quiet stall windows.
      vi.advanceTimersByTime(1000)

      expect(isPaneReplaying(ref, 1)).toBe(false)
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
})

describe('replay-guard stall handling (probe-certified release)', () => {
  it('waits for the FIFO replay sentinel without releasing on elapsed time', async () => {
    vi.useFakeTimers()
    const { terminal } = makeFakePane(1)
    let resolved = false

    void waitForTerminalReplayWritesParsed(terminal, { stallCheckMs: 1_000 }).then(() => {
      resolved = true
    })
    expect(terminal.lastData).toEqual([new Uint8Array(0)])

    vi.advanceTimersByTime(1_000)
    expect(terminal.lastData).toEqual([new Uint8Array(0), new Uint8Array(0)])
    expect(resolved).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(resolved).toBe(false)

    terminal.flush()
    await Promise.resolve()
    expect(resolved).toBe(true)
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

      // Probe completion proves every earlier replay byte parsed, making release safe.
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

      // A certified silent parser cannot emit query replies, so bounded wedge release cannot leak input.
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

      vi.advanceTimersByTime(120_000)
    } finally {
      errorSpy.mockRestore()
    }
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
