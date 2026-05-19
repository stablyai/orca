import { afterEach, describe, expect, it, vi } from 'vitest'

function createTerminal() {
  return {
    write: vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
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

    expect(terminal.write).toHaveBeenCalledWith('foreground')
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
