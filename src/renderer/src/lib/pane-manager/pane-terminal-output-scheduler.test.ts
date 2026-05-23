import { afterEach, describe, expect, it, vi } from 'vitest'

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
  afterEach(() => {
    vi.useRealTimers()
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

    writeTerminalOutput(terminal, '中文 PowerShell repaint\r\n', { foreground: true })

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

    writeTerminalOutput(terminal, '顶部滚动中文复现\r\n', { foreground: true })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('hides the foreground cursor until output parsing has gone quiet', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'frame', { foreground: true })

    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(true)
    expect(terminal.write).toHaveBeenCalledWith('frame', expect.any(Function))

    vi.advanceTimersByTime(63)
    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(true)

    vi.advanceTimersByTime(1)
    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(false)
  })

  it('can hide the cursor immediately while input waits for echoed output', async () => {
    vi.useFakeTimers()
    const { suppressTerminalCursorUntilOutputSettles } = await loadScheduler()
    const terminal = createTerminal()

    suppressTerminalCursorUntilOutputSettles(terminal)

    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(true)

    vi.advanceTimersByTime(499)
    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(true)

    vi.advanceTimersByTime(1)
    expect(terminal.classes.has('terminal-foreground-write-pending')).toBe(false)
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

  it('flushes queued output before foreground output on the same terminal', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'old', { foreground: false })
    writeTerminalOutput(terminal, 'new', { foreground: true })

    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['old', 'new'])
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
