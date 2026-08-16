import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

describe('pane terminal output scheduler', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    mocks.recordRendererCrashBreadcrumb.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
  })

  it('coalesces synchronized foreground frame endings with immediate cursor restore bytes', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      coalesceForeground: true
    })

    expect(terminal.write).not.toHaveBeenCalled()

    writeTerminalOutput(terminal, '\x1b[?25l\x1b[22;4H\x1b[?25h', {
      foreground: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026l\x1b[?25l\x1b[22;4H\x1b[?25h',
      expect.any(Function)
    )
  })

  it('drains harmless synchronized endings when latency-sensitive foreground follows', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b]0;spinner\x07\x1b[?2026h\x1b[0 q\x1b[?2026l', {
      foreground: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(0)
    expect(terminal.write).not.toHaveBeenCalled()

    writeTerminalOutput(terminal, 's', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b]0;spinner\x07\x1b[?2026h\x1b[0 q\x1b[?2026ls',
      expect.any(Function)
    )
  })

  it('waits for cursor restore when synchronized output ends with a transient show', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(0)
    expect(terminal.write).not.toHaveBeenCalled()

    writeTerminalOutput(terminal, '\x1b[?25l\x1b[13;4H\x1b[?25h', {
      foreground: true,
      stripTransientCursorShows: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?2026l\x1b[?25l\x1b[13;4H\x1b[?25h',
      expect.any(Function)
    )
  })

  it('keeps transient cursor shows coalesced when latency-sensitive foreground lacks restore', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    writeTerminalOutput(terminal, 's', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('does not hold latency-sensitive input behind a synchronized restore fallback', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    writeTerminalOutput(terminal, 'typed', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true
    })

    vi.advanceTimersByTime(15)
    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()

    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?2026l\x1b[?25htyped',
      expect.any(Function)
    )
  })

  it('does not hold latency-sensitive synchronized endings behind the restore fallback', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[13;14Hr\x1b[?25h', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      holdForeground: true
    })
    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(15)
    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()

    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[13;14Hr\x1b[?2026l\x1b[?25h',
      expect.any(Function)
    )
  })

  it('defers synchronized cursor shows until after the frame ends', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[26;59H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(16)
    vi.runOnlyPendingTimers()

    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[26;59H\x1b[?2026l\x1b[?25h',
      expect.any(Function)
    )
  })

  it('drains synchronized endings with final cursor placement before the fallback', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(
      terminal,
      '\x1b[?2026h\x1b[?25l\x1b[13;14Hr\x1b[5 q\x1b[?25h\x1b[19;3H\x1b[?2026l',
      {
        foreground: true,
        latencySensitive: true,
        stripTransientCursorShows: true,
        coalesceForeground: true
      }
    )

    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[13;14Hr\x1b[5 q\x1b[19;3H\x1b[?25h\x1b[?2026l',
      expect.any(Function)
    )
  })

  it('does not batch repeated latency-sensitive synchronized frames across key-repeat ticks', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;3Hx\x1b[?25h', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      holdForeground: true
    })
    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(16)
    vi.runOnlyPendingTimers()
    expect(terminal.write).toHaveBeenCalledTimes(1)

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;4Hx\x1b[?25h', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      holdForeground: true
    })
    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      latencySensitive: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(16)
    vi.runOnlyPendingTimers()

    expect(terminal.write).toHaveBeenCalledTimes(2)
    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual([
      '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;3Hx\x1b[?2026l\x1b[?25h',
      '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;4Hx\x1b[?2026l\x1b[?25h'
    ])
  })

  it('keeps transient cursor shows unless the caller opts into stripping', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      coalesceForeground: true
    })
    writeTerminalOutput(terminal, '\x1b[?25l\x1b[13;4H\x1b[?25h', {
      foreground: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[13;4H\x1b[?25h',
      expect.any(Function)
    )
  })

  it('holds synchronized foreground frames until their end marker arrives', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25l\x1b[10;5HWorking', {
      foreground: true,
      forceForegroundRefresh: true,
      stripTransientCursorShows: true,
      holdForeground: true
    })

    vi.advanceTimersByTime(249)
    expect(terminal.write).not.toHaveBeenCalled()

    writeTerminalOutput(terminal, '\x1b[10;6Hk', {
      foreground: true,
      forceForegroundRefresh: true,
      stripTransientCursorShows: true,
      holdForeground: true
    })
    vi.advanceTimersByTime(249)
    expect(terminal.write).not.toHaveBeenCalled()

    writeTerminalOutput(terminal, '\x1b[10;8H\x1b[?25h\x1b[?2026l', {
      foreground: true,
      forceForegroundRefresh: true,
      stripTransientCursorShows: true,
      coalesceForeground: true
    })
    writeTerminalOutput(terminal, '\x1b[?25l\x1b[13;4H\x1b[?25h', {
      foreground: true,
      stripTransientCursorShows: true
    })
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25l\x1b[10;5HWorking\x1b[10;6Hk\x1b[10;8H\x1b[?2026l\x1b[?25l\x1b[13;4H\x1b[?25h',
      expect.any(Function)
    )
  })

  it('safety-flushes a synchronized foreground hold if no end marker arrives', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25lpartial', {
      foreground: true,
      holdForeground: true
    })

    vi.advanceTimersByTime(249)
    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()
    expect(terminal.write).toHaveBeenCalledWith('\x1b[?2026h\x1b[?25lpartial', expect.any(Function))
  })

  // Why: issue #8754 — ConPTY splits Codex spinner frames into an open chunk and a
  // close chunk; hold and coalesce each cancelled the other's fallback timer, so a
  // visible pane never repainted until the tab was blurred.
  it('keeps repainting when synchronized frames alternate hold and coalesce chunks', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    const writeFrameOpen = (frame: number): void => {
      writeTerminalOutput(terminal, `\x1b[?2026h\x1b[?25l\x1b[10;5HWorking ${frame}`, {
        foreground: true,
        forceForegroundRefresh: true,
        stripTransientCursorShows: true,
        holdForeground: true
      })
    }
    // Codex shows the cursor before the end marker, so this never hits the immediate-drain escape.
    const writeFrameClose = (): void => {
      writeTerminalOutput(terminal, '\x1b[10;8H\x1b[?25h\x1b[?2026l', {
        foreground: true,
        forceForegroundRefresh: true,
        stripTransientCursorShows: true,
        coalesceForeground: true
      })
    }

    writeFrameOpen(0)
    vi.advanceTimersByTime(100)
    writeFrameClose()
    vi.advanceTimersByTime(100)
    writeFrameOpen(1)
    vi.advanceTimersByTime(60)
    expect(terminal.write).toHaveBeenCalledTimes(1)

    for (let frame = 2; frame < 8; frame += 1) {
      writeFrameClose()
      vi.advanceTimersByTime(100)
      writeFrameOpen(frame)
      vi.advanceTimersByTime(100)
    }

    expect(terminal.write.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('safety-flushes latency-sensitive synchronized holds without a visible input delay', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026h\x1b[?25linput redraw', {
      foreground: true,
      holdForeground: true,
      latencySensitive: true
    })

    vi.advanceTimersByTime(31)
    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026h\x1b[?25linput redraw',
      expect.any(Function)
    )
  })

  it('drains a synchronized foreground ending after the restore coalescing window', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      coalesceForeground: true
    })

    vi.advanceTimersByTime(999)
    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()
    expect(terminal.write).toHaveBeenCalledWith('\x1b[?2026l', expect.any(Function))
  })

  it('does not extend the synchronized foreground coalescing window with later output', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, '\x1b[?2026l', {
      foreground: true,
      coalesceForeground: true
    })

    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(240)
      writeTerminalOutput(terminal, `chunk-${index}`, { foreground: true })
    }

    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(40)
    vi.runOnlyPendingTimers()

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?2026lchunk-0chunk-1chunk-2chunk-3',
      expect.any(Function)
    )
  })
})
