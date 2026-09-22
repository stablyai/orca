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

  describe('parse-deferred ACK crediting', () => {
    // Why these tests: the credit invariant is "every delivered chunk credits
    // exactly once, whether parsed or discarded" — a missed credit permanently
    // shrinks main's in-flight window and wedges the PTY (rc.7.perf).
    function makeCredit(): { fire: () => void; count: () => number } {
      let fired = 0
      return { fire: () => (fired += 1), count: () => fired }
    }

    it('credits when a queued chunk finishes parsing', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'queued', {
        foreground: true,
        latencySensitive: false,
        ackCredit: credit.fire
      })
      expect(credit.count()).toBe(0)

      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledWith('queued', expect.any(Function))
      expect(credit.count()).toBe(0)
      parsed?.()
      expect(credit.count()).toBe(1)
    })

    it('credits exactly once when a chunk is split across drain slices', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const credit = makeCredit()

      // 40 KB > the 16 KB slice size: consumed across multiple drain writes.
      writeTerminalOutput(terminal, 'q'.repeat(40 * 1024), {
        foreground: true,
        latencySensitive: false,
        ackCredit: credit.fire
      })
      for (let index = 0; index < 24; index += 1) {
        vi.advanceTimersByTime(4)
      }
      const written = terminal.write.mock.calls.map((call) => String(call[0])).join('')
      expect(written).toContain('q'.repeat(40 * 1024))
      expect(credit.count()).toBe(1)
    })

    it('defers split-chunk credit and onParsed until the final slice parses', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const parseCallbacks: (() => void)[] = []
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        if (callback) {
          parseCallbacks.push(callback)
        }
      })
      const credit = makeCredit()
      const onParsed = vi.fn()

      writeTerminalOutput(terminal, 'q'.repeat(40 * 1024), {
        foreground: true,
        latencySensitive: false,
        ackCredit: credit.fire,
        onParsed
      })
      vi.advanceTimersByTime(0)

      expect(parseCallbacks).toHaveLength(3)
      parseCallbacks[0]()
      parseCallbacks[1]()
      expect(credit.count()).toBe(0)
      expect(onParsed).not.toHaveBeenCalled()
      parseCallbacks[2]()
      expect(credit.count()).toBe(1)
      expect(onParsed).toHaveBeenCalledTimes(1)
    })

    it('credits when the foreground backlog is replaced with the overflow warning', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput, configureTerminalOutputBacklogCap } = await loadScheduler()
      configureTerminalOutputBacklogCap(1_000)
      const terminal = createTerminal()
      // Never complete a write so the queue only grows.
      terminal.write.mockImplementation(() => {})
      const credits = [makeCredit(), makeCredit(), makeCredit()]

      for (const credit of credits) {
        writeTerminalOutput(terminal, 'x'.repeat(1024 * 1024), {
          foreground: true,
          latencySensitive: false,
          ackCredit: credit.fire
        })
      }
      // The cap replacement discards queued chunks — their deliveries still
      // consumed and must credit.
      for (const credit of credits) {
        expect(credit.count()).toBe(1)
      }
    })

    it('credits when queued output is discarded', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput, discardTerminalOutput } = await loadScheduler()
      const { captureTerminalParseProgressGeneration, hasTerminalParseProgressSince } =
        await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {})
      const credit = makeCredit()
      const parseGeneration = captureTerminalParseProgressGeneration(terminal)

      writeTerminalOutput(terminal, 'doomed', {
        foreground: true,
        latencySensitive: false,
        ackCredit: credit.fire
      })
      expect(credit.count()).toBe(0)
      discardTerminalOutput(terminal)
      expect(credit.count()).toBe(1)
      // Discard settles delivery ownership, not xterm parsing; replay wedge
      // deadlines must not treat cleanup as evidence that the parser is alive.
      expect(hasTerminalParseProgressSince(terminal, parseGeneration)).toBe(false)
    })

    it('discards queued output when replay certification precedes the drain', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()
      const { _resetWritePipelineHealthForTests, notifyUndeliverableWrite } =
        await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      const credits = [vi.fn(), vi.fn(), vi.fn()]
      try {
        for (const [index, credit] of credits.entries()) {
          writeTerminalOutput(terminal, `queued-${index}`, {
            foreground: false,
            ackCredit: credit
          })
        }

        notifyUndeliverableWrite(terminal, 'replay-wedged')
        vi.advanceTimersByTime(100)

        expect(terminal.write).not.toHaveBeenCalled()
        for (const credit of credits) {
          expect(credit).toHaveBeenCalledTimes(1)
        }
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('discards queued output when a certified terminal is flushed', async () => {
      vi.useFakeTimers()
      const { flushTerminalOutput, writeTerminalOutput } = await loadScheduler()
      const { _resetWritePipelineHealthForTests, notifyUndeliverableWrite } =
        await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      const credit = vi.fn()
      try {
        writeTerminalOutput(terminal, 'queued', {
          foreground: false,
          ackCredit: credit
        })
        notifyUndeliverableWrite(terminal, 'replay-wedged')

        flushTerminalOutput(terminal)

        expect(terminal.write).not.toHaveBeenCalled()
        expect(credit).toHaveBeenCalledTimes(1)
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('does not probe a certified terminal while waiting for parsed output', async () => {
      const { waitForTerminalOutputParsed } = await loadScheduler()
      const { _resetWritePipelineHealthForTests, notifyUndeliverableWrite } =
        await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      try {
        notifyUndeliverableWrite(terminal, 'replay-wedged')

        await waitForTerminalOutputParsed(terminal)

        expect(terminal.write).not.toHaveBeenCalled()
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('records parse progress when the parsed-output probe completes', async () => {
      const { waitForTerminalOutputParsed } = await loadScheduler()
      const {
        _resetWritePipelineHealthForTests,
        captureTerminalParseProgressGeneration,
        hasTerminalParseProgressSince
      } = await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      try {
        const generation = captureTerminalParseProgressGeneration(terminal)
        const wait = waitForTerminalOutputParsed(terminal)

        parsed?.()
        await wait

        expect(hasTerminalParseProgressSince(terminal, generation)).toBe(true)
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('certifies a terminal whose parsed-output probe throws synchronously', async () => {
      const { waitForTerminalOutputParsed } = await loadScheduler()
      const { _resetWritePipelineHealthForTests, isTerminalWritePipelineCertifiedDead } =
        await import('./terminal-write-pipeline-health')
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {
        throw new Error('disposed')
      })
      try {
        await waitForTerminalOutputParsed(terminal)

        expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('credits an empty write immediately', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const credit = makeCredit()

      writeTerminalOutput(terminal, '', { foreground: true, ackCredit: credit.fire })
      expect(credit.count()).toBe(1)
    })

    it('credits the immediate foreground path after its parse callback', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'now', { foreground: true, ackCredit: credit.fire })
      expect(terminal.write).toHaveBeenCalledWith('now', expect.any(Function))
      expect(credit.count()).toBe(0)
      parsed?.()
      expect(credit.count()).toBe(1)
    })

    it('credits submitted but unparsed output when the terminal is discarded', async () => {
      const { writeTerminalOutput, discardTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {})
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'submitted', { foreground: true, ackCredit: credit.fire })
      expect(credit.count()).toBe(0)
      discardTerminalOutput(terminal)
      expect(credit.count()).toBe(1)
    })
  })
})
