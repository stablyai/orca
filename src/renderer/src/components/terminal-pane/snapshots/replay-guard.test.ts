import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import '@/lib/pane-manager/pane-lifecycle'
import {
  isPaneReplaying,
  replayIntoTerminal,
  replayIntoTerminalAsync,
  type ReplayingPanesRef
} from './replay-guard'
import '@/lib/pane-manager/terminal-rendering/terminal-arabic-shaping-joiner'
import '@/lib/pane-manager/terminal-output/terminal-write-pipeline-health'

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
})

describe('replay-guard stall handling (probe-certified release)', () => {
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
