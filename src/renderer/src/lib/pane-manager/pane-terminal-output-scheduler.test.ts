/* eslint-disable max-lines -- Why: the scheduler tests cover one queue state machine; keeping ordering and overflow cases together makes regressions easier to audit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

function createTerminal() {
  const classes = new Set<string>()
  return {
    classes,
    element: {
      classList: {
        add: vi.fn((className: string) => {
          classes.add(className)
        }),
        remove: vi.fn((className: string) => {
          classes.delete(className)
        })
      }
    },
    write: vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
  }
}

function createForegroundTerminal() {
  return {
    buffer: {
      active: {
        cursorY: 7,
        baseY: 0,
        viewportY: 0
      }
    },
    rows: 24,
    refresh: vi.fn(),
    _core: {
      refresh: vi.fn()
    },
    write: vi.fn((_data: string, callback?: () => void) => callback?.())
  }
}

async function loadScheduler() {
  vi.resetModules()
  return import('./pane-terminal-output-scheduler')
}

describe('pane terminal output scheduler', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
  })

  it('writes foreground output immediately', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'foreground', { foreground: true })

    expect(terminal.write).toHaveBeenCalledWith('foreground', expect.any(Function))
  })

  it('synchronously refreshes visible rows after foreground output parses', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      terminal.buffer.active.cursorY = 3
      callback?.()
    })

    writeTerminalOutput(terminal, '中文 PowerShell repaint\r\n', {
      foreground: true,
      forceForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 23, true)
    expect(terminal.refresh).not.toHaveBeenCalled()
  })

  it('repaints the viewport again on the next frame when foreground output scrolls', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    terminal.buffer.active.baseY = 10
    terminal.buffer.active.viewportY = 10
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      terminal.buffer.active.baseY = 11
      terminal.buffer.active.viewportY = 11
      callback?.()
    })

    writeTerminalOutput(terminal, '顶部滚动中文复现\r\n', {
      foreground: true,
      forceForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('can force a follow-up repaint after cursor-only foreground restores', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, '\x1b[?25l\x1b[13;4H\x1b[?25h', {
      foreground: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('skips forced viewport refresh for ordinary foreground output', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, 'plain foreground output\r\n', { foreground: true })

    expect(terminal._core.refresh).not.toHaveBeenCalled()
    expect(terminal.refresh).not.toHaveBeenCalled()
  })

  it('coalesces background output until the shared drain runs', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'a', { foreground: false })
    writeTerminalOutput(terminal, 'b', { foreground: false })

    expect(terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith('ab')
  })

  it('defers throughput foreground output to the shared high-priority drain', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'a'.repeat(16 * 1024), {
      foreground: true,
      latencySensitive: false
    })
    writeTerminalOutput(terminal, 'b'.repeat(16 * 1024), {
      foreground: true,
      latencySensitive: false
    })

    expect(terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledTimes(2)
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(
      `${'a'.repeat(16 * 1024)}${'b'.repeat(16 * 1024)}`
    )
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
      '\x1b[?2026h\x1b[?25l\x1b[10;8H\x1b[?25h\x1b[?2026ltyped',
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
      '\x1b[?2026h\x1b[?25l\x1b[13;14Hr\x1b[?25h\x1b[?2026l',
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
      '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;3Hx\x1b[?25h\x1b[?2026l',
      '\x1b[?2026h\x1b[0 q\x1b[?25l\x1b[19;4Hx\x1b[?25h\x1b[?2026l'
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

  it('defers background write preparation until coalesced output drains', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const beforeWrite = vi.fn()

    writeTerminalOutput(terminal, 'a', { foreground: false, beforeWrite })
    writeTerminalOutput(terminal, 'b', { foreground: false, beforeWrite })

    expect(beforeWrite).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    expect(beforeWrite).toHaveBeenCalledTimes(1)
    expect(beforeWrite).toHaveBeenCalledWith('ab')
    expect(terminal.write).toHaveBeenCalledWith('ab')
  })

  it('runs deferred write preparation before explicit background flushes', async () => {
    vi.useFakeTimers()
    const { flushTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const beforeWrite = vi.fn((chunk: string) => {
      expect(terminal.write).not.toHaveBeenCalledWith(chunk)
    })

    writeTerminalOutput(terminal, 'hidden', { foreground: false, beforeWrite })
    flushTerminalOutput(terminal)

    expect(beforeWrite).toHaveBeenCalledTimes(1)
    expect(beforeWrite).toHaveBeenCalledWith('hidden')
    expect(terminal.write).toHaveBeenCalledWith('hidden')
  })

  it('supports bounded explicit flushes for visibility resume', async () => {
    vi.useFakeTimers()
    const { flushTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 16; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    flushTerminalOutput(terminal, { maxChars: 64 * 1024 })

    expect(terminal.write).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(50)
    expect(terminal.write.mock.calls.length).toBeGreaterThan(4)
  })

  it('limits how many background terminals begin xterm writes per drain tick', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]

    terminals.forEach((terminal, index) => {
      writeTerminalOutput(terminal, `pane-${index}`, { foreground: false })
    })

    vi.advanceTimersByTime(50)
    expect(terminals[0].write).toHaveBeenCalledWith('pane-0')
    expect(terminals[1].write).toHaveBeenCalledWith('pane-1')
    expect(terminals[2].write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(terminals[2].write).toHaveBeenCalledWith('pane-2')
  })

  it('drains the active terminal before older queued background terminals', async () => {
    vi.useFakeTimers()
    const { setActiveTerminalOutputTarget, writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]

    terminals.forEach((terminal, index) => {
      writeTerminalOutput(terminal, `pane-${index}`, { foreground: false })
    })
    setActiveTerminalOutputTarget(terminals[2], true)

    vi.advanceTimersByTime(50)

    expect(terminals[2].write).toHaveBeenCalledWith('pane-2')
    expect(terminals[0].write).toHaveBeenCalledWith('pane-0')
    expect(terminals[1].write).not.toHaveBeenCalled()

    setActiveTerminalOutputTarget(terminals[2], false)
  })

  it('still drains the active terminal first with one hundred queued terminals', async () => {
    vi.useFakeTimers()
    const { setActiveTerminalOutputTarget, writeTerminalOutput } = await loadScheduler()
    const terminals = Array.from({ length: 100 }, () => createTerminal())
    const activeTerminal = terminals[99]

    terminals.forEach((terminal, index) => {
      writeTerminalOutput(terminal, `pane-${index}`, { foreground: false })
    })
    setActiveTerminalOutputTarget(activeTerminal, true)

    vi.advanceTimersByTime(50)

    expect(activeTerminal.write).toHaveBeenCalledWith('pane-99')
    expect(terminals[0].write).toHaveBeenCalledWith('pane-0')
    expect(activeTerminal.write.mock.invocationCallOrder[0]).toBeLessThan(
      terminals[0].write.mock.invocationCallOrder[0]
    )
  })

  it('rotates terminals with remaining backlog behind untouched queued terminals', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]
    const largeChunk = 'x'.repeat(20 * 1024)

    writeTerminalOutput(terminals[0], largeChunk, { foreground: false })
    writeTerminalOutput(terminals[1], 'pane-1', { foreground: false })
    writeTerminalOutput(terminals[2], 'pane-2', { foreground: false })

    vi.advanceTimersByTime(50)
    expect(terminals[0].write).toHaveBeenCalledTimes(1)
    expect(terminals[1].write).toHaveBeenCalledWith('pane-1')
    expect(terminals[2].write).not.toHaveBeenCalled()

    // Why: a terminal with leftover bytes is deleted/re-set after each drain
    // chunk, moving it to the back of the Map so a big burst cannot starve
    // other queued panes.
    vi.advanceTimersByTime(16)
    expect(terminals[2].write).toHaveBeenCalledWith('pane-2')
    expect(terminals[0].write).toHaveBeenCalledTimes(2)
  })

  it('reports current and peak queued renderer backlog in debug snapshots', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminalA = createTerminal()
    const terminalB = createTerminal()
    const debug = (
      window as unknown as {
        __terminalOutputSchedulerDebug?: {
          snapshot: () => {
            queuedTerminalCount: number
            queuedChars: number
            peakQueuedTerminalCount: number
            peakQueuedChars: number
            peakQueuedCharsByTerminal: number
            droppedBacklogCount: number
          }
        }
      }
    ).__terminalOutputSchedulerDebug

    writeTerminalOutput(terminalA, 'a'.repeat(10), { foreground: false })
    writeTerminalOutput(terminalB, 'b'.repeat(20), { foreground: false })

    expect(debug?.snapshot()).toMatchObject({
      queuedTerminalCount: 2,
      queuedChars: 30,
      peakQueuedTerminalCount: 2,
      peakQueuedChars: 30,
      peakQueuedCharsByTerminal: 20,
      droppedBacklogCount: 0
    })

    vi.advanceTimersByTime(50)

    expect(debug?.snapshot()).toMatchObject({
      queuedTerminalCount: 0,
      queuedChars: 0,
      peakQueuedTerminalCount: 2,
      peakQueuedChars: 30,
      peakQueuedCharsByTerminal: 20,
      droppedBacklogCount: 0
    })
  })

  it('keeps draining background chunks without per-write parse callback backpressure', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 6; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(16)

    expect(terminal.write).toHaveBeenCalledTimes(4)

    vi.advanceTimersByTime(16)

    expect(terminal.write).toHaveBeenCalledTimes(6)
  })

  it('promotes large background backlogs to high-priority drains', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 64; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    expect(terminal.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(0)
    expect(terminal.write).toHaveBeenCalledTimes(16)

    vi.advanceTimersByTime(1)
    expect(terminal.write).toHaveBeenCalledTimes(32)
  })

  it('caps hidden backlog memory and writes a warning instead of retaining all output', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(512 * 1024)

    for (let i = 0; i < 5; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }
    writeTerminalOutput(terminal, 'after-cap\r\n', { foreground: false })

    vi.advanceTimersByTime(0)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped hidden terminal output')
    expect(output).toContain('after-cap')
    expect(output).not.toContain('x'.repeat(1024))
  })

  it('caps hidden backlog chunk count even when each chunk is tiny', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    for (let i = 0; i < 4097; i++) {
      writeTerminalOutput(terminal, 'x', { foreground: false })
    }

    vi.advanceTimersByTime(0)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped hidden terminal output')
    expect(output).not.toContain('x'.repeat(512))
  })

  it('requests registered recovery instead of flushing a dropped hidden backlog', async () => {
    vi.useFakeTimers()
    const { flushTerminalOutput, registerTerminalBacklogRecovery, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const requestRecovery = vi.fn(() => true)
    const unregister = registerTerminalBacklogRecovery(terminal, requestRecovery)
    const chunk = 'x'.repeat(512 * 1024)

    try {
      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      flushTerminalOutput(terminal)

      expect(requestRecovery).toHaveBeenCalledTimes(1)
      expect(terminal.write).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('flushes queued output before foreground output on the same terminal', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'old', { foreground: false })
    writeTerminalOutput(terminal, 'new', { foreground: true })

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['old', 'new'])
  })

  it('yields instead of synchronously flushing a large hidden backlog on foreground output', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 64; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    writeTerminalOutput(terminal, 'visible', { foreground: true })

    expect(terminal.write.mock.calls.length).toBeLessThan(64)
    vi.advanceTimersByTime(50)

    expect(terminal.write.mock.calls.length).toBeGreaterThan(0)
  })

  it('preserves byte order when foreground output is queued behind a large hidden backlog', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 64; i++) {
      writeTerminalOutput(terminal, `${String(i).padStart(2, '0')}:${chunk}`, {
        foreground: false
      })
    }

    writeTerminalOutput(terminal, 'visible', { foreground: true })
    vi.runAllTimers()

    const expected = `${Array.from(
      { length: 64 },
      (_, i) => `${String(i).padStart(2, '0')}:${chunk}`
    ).join('')}visible`
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(expected)
    expect(terminal.write).toHaveBeenLastCalledWith('visible', expect.any(Function))
  })

  it('discards queued output for disposed terminals', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'stale', { foreground: false })
    discardTerminalOutput(terminal)
    vi.advanceTimersByTime(50)

    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('clears active priority when terminal output is discarded', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, setActiveTerminalOutputTarget, writeTerminalOutput } =
      await loadScheduler()
    const terminalA = createTerminal()
    const terminalB = createTerminal()

    setActiveTerminalOutputTarget(terminalB, true)
    discardTerminalOutput(terminalB)
    writeTerminalOutput(terminalA, 'new-a', { foreground: false })
    writeTerminalOutput(terminalB, 'new-b', { foreground: false })
    vi.advanceTimersByTime(50)

    expect(terminalB.write).toHaveBeenCalledWith('new-b')
    expect(terminalA.write).toHaveBeenCalledWith('new-a')
    expect(terminalA.write.mock.invocationCallOrder[0]).toBeLessThan(
      terminalB.write.mock.invocationCallOrder[0]
    )
  })

  it('survives a write to a disposed terminal during background drain', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const throwing = {
      write: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }

    writeTerminalOutput(throwing, 'late-ping', { foreground: false })

    // Why: drain runs inside setTimeout; if the throw escapes drainQueuedOutput
    // it would crash the timer callback and leave the scheduler poisoned.
    expect(() => vi.advanceTimersByTime(50)).not.toThrow()
    expect(throwing.write).toHaveBeenCalledTimes(1)

    // Advancing further must not rediscover the dead entry.
    vi.advanceTimersByTime(100)
    expect(throwing.write).toHaveBeenCalledTimes(1)
  })
})
