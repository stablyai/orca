import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createForegroundTerminal,
  createTerminal,
  loadScheduler
} from './pane-terminal-output-scheduler-test-harness'

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

  it('coalesces background output until the shared drain runs', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'a', { foreground: false })
    writeTerminalOutput(terminal, 'b', { foreground: false })

    expect(terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledWith('ab', expect.any(Function))
  })

  it('runs parsed callbacks after background output parses without foreground refresh', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    const writes: string[] = []
    const parseCallbacks: (() => void)[] = []
    terminal.write = function write(data: string, callback?: () => void): void {
      writes.push(data)
      if (callback) {
        parseCallbacks.push(callback)
      }
    } as typeof terminal.write
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'hidden redraw', {
      foreground: false,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true,
      onParsed
    })

    vi.advanceTimersByTime(50)

    expect(writes).toEqual(['hidden redraw'])
    expect(onParsed).not.toHaveBeenCalled()
    expect(terminal._core.refresh).not.toHaveBeenCalled()

    parseCallbacks[0]?.()

    expect(onParsed).toHaveBeenCalledTimes(1)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })

  it('runs parsed callbacks after the final background slice', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const writes: string[] = []
    const parseCallbacks: (() => void)[] = []
    terminal.write = function write(data: string, callback?: () => void): void {
      writes.push(data)
      if (callback) {
        parseCallbacks.push(callback)
      }
    } as typeof terminal.write
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'x'.repeat(20 * 1024), {
      foreground: false,
      onParsed
    })

    vi.advanceTimersByTime(50)

    expect(writes.map((data) => data.length)).toEqual([16 * 1024, 4 * 1024])
    // Why 2: every slice now carries a completion callback (it settles the
    // write-pipeline stall watch); onParsed still fires only with the final one.
    expect(parseCallbacks).toHaveLength(2)
    expect(onParsed).not.toHaveBeenCalled()

    parseCallbacks[0]?.()
    expect(onParsed).not.toHaveBeenCalled()

    parseCallbacks[1]?.()

    expect(onParsed).toHaveBeenCalledTimes(1)
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
    expect(terminal.write).toHaveBeenCalledWith('ab', expect.any(Function))
  })

  it('keeps preparation attached when a later producer omits it', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const beforeWrite = vi.fn()

    writeTerminalOutput(terminal, 'مرحبا', { foreground: false, beforeWrite })
    writeTerminalOutput(terminal, ' fallback notice', { foreground: false })
    vi.advanceTimersByTime(50)

    expect(beforeWrite).toHaveBeenCalledWith('مرحبا fallback notice')
    expect(terminal.write).toHaveBeenCalledWith('مرحبا fallback notice', expect.any(Function))
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
    expect(terminal.write).toHaveBeenCalledWith('hidden', expect.any(Function))
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
    expect(terminals[0].write).toHaveBeenCalledWith('pane-0', expect.any(Function))
    expect(terminals[1].write).toHaveBeenCalledWith('pane-1', expect.any(Function))
    expect(terminals[2].write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(terminals[2].write).toHaveBeenCalledWith('pane-2', expect.any(Function))
  })

  it('drains active foreground backlog before older background terminal backlog', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const backgroundA = createTerminal()
    const backgroundB = createTerminal()
    const active = createTerminal()

    writeTerminalOutput(backgroundA, 'background-a', { foreground: false })
    writeTerminalOutput(backgroundB, 'background-b', { foreground: false })
    writeTerminalOutput(active, 'active', {
      foreground: true,
      latencySensitive: false
    })

    vi.advanceTimersByTime(0)

    expect(active.write).toHaveBeenCalledWith('active', expect.any(Function))
    expect(active.write.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundA.write.mock.invocationCallOrder[0]
    )
    expect(active.write.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundB.write.mock.invocationCallOrder[0]
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
    expect(terminals[1].write).toHaveBeenCalledWith('pane-1', expect.any(Function))
    expect(terminals[2].write).not.toHaveBeenCalled()

    // Why: a terminal with leftover bytes is deleted/re-set after each drain
    // chunk, moving it to the back of the Map so a big burst cannot starve
    // other queued panes.
    vi.advanceTimersByTime(16)
    expect(terminals[2].write).toHaveBeenCalledWith('pane-2', expect.any(Function))
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
            drainWrites: number[]
            drainHighPriority: boolean[]
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
      droppedBacklogCount: 0,
      drainWrites: [2],
      drainHighPriority: [false]
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
    const debug = (
      window as unknown as {
        __terminalOutputSchedulerDebug?: {
          snapshot: () => { drainWrites: number[]; drainHighPriority: boolean[] }
        }
      }
    ).__terminalOutputSchedulerDebug
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 64; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    expect(terminal.write).not.toHaveBeenCalled()

    // Why 8: promoted backlogs use the parse-clocked high-priority budget
    // (HIGH_PRIORITY_MAX_WRITES_PER_DRAIN) so a visible flood drains at the
    // parser's pace instead of a fixed 2-write drip.
    vi.advanceTimersByTime(0)
    expect(terminal.write).toHaveBeenCalledTimes(8)
    expect(debug?.snapshot()).toMatchObject({
      drainWrites: [8],
      drainHighPriority: [true]
    })

    vi.advanceTimersByTime(4)
    expect(terminal.write).toHaveBeenCalledTimes(16)
    expect(debug?.snapshot()).toMatchObject({
      drainWrites: [8, 8],
      drainHighPriority: [true, true]
    })
  })

  it('yields high-priority backlog drains when writes spend the frame budget', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)
    let now = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      now += 9
      callback?.()
    })

    try {
      for (let i = 0; i < 64; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(4)
      expect(terminal.write).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('uses Date.now for drain budgeting when performance is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('performance', undefined)
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)
    let now = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      now += 9
      callback?.()
    })

    try {
      for (let i = 0; i < 64; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledTimes(1)
      expect(nowSpy).toHaveBeenCalled()

      vi.advanceTimersByTime(4)
      expect(terminal.write).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
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
})
