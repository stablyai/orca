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

  it('discards queued output for disposed terminals', async () => {
    vi.useFakeTimers()
    const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'stale', { foreground: false })
    discardTerminalOutput(terminal)
    vi.advanceTimersByTime(50)

    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('does not feed a replay quiet window when foreground writes are rejected', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const {
      _resetWritePipelineHealthForTests,
      captureTerminalParseProgressGeneration,
      hasTerminalParseProgressSince,
      isTerminalWritePipelineCertifiedDead,
      registerUndeliverableWriteHandler
    } = await import('./terminal-write-pipeline-health')
    const terminal = createForegroundTerminal()
    terminal.write.mockImplementation(() => {
      throw new Error('terminal disposed')
    })
    const recoveryReasons: string[] = []
    const unregister = registerUndeliverableWriteHandler(terminal, (reason) => {
      recoveryReasons.push(reason)
    })
    const generation = captureTerminalParseProgressGeneration(terminal)
    const ackCredits = [vi.fn(), vi.fn(), vi.fn()]
    const onParsed = vi.fn()
    try {
      for (const [index, ackCredit] of ackCredits.entries()) {
        writeTerminalOutput(terminal, `rejected-${index}`, {
          foreground: true,
          ackCredit,
          onParsed
        })
      }

      // This generation is exactly what a pending replay guard consults.
      expect(hasTerminalParseProgressSince(terminal, generation)).toBe(false)
      expect(recoveryReasons).toEqual(['write-stalled'])
      expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
      // Only the first rejection touches xterm; later PTY deliveries credit
      // directly while recovery owns the certified-dead instance.
      expect(terminal.write).toHaveBeenCalledTimes(1)
      expect(onParsed).not.toHaveBeenCalled()
      for (const ackCredit of ackCredits) {
        expect(ackCredit).toHaveBeenCalledTimes(1)
      }
    } finally {
      unregister()
      _resetWritePipelineHealthForTests(terminal)
    }
  })

  it('survives a write to a disposed terminal during background drain', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const throwing = {
      write: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }

    // More than two drain slices: rejection must abandon the detached tail
    // instead of synchronously retrying the same certified-dead xterm.
    writeTerminalOutput(throwing, 'x'.repeat(40 * 1024), { foreground: false })

    // Why: drain runs inside setTimeout; if the throw escapes drainQueuedOutput
    // it would crash the timer callback and leave the scheduler poisoned.
    expect(() => vi.advanceTimersByTime(50)).not.toThrow()
    expect(throwing.write).toHaveBeenCalledTimes(1)

    // Advancing further must not rediscover the dead entry.
    vi.advanceTimersByTime(100)
    expect(throwing.write).toHaveBeenCalledTimes(1)
  })
})
