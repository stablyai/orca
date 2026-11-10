import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  armTerminalWriteStallWatch,
  captureTerminalParseProgressGeneration,
  hasTerminalParseProgressSince,
  isTerminalWritePipelineCertifiedDead,
  registerUndeliverableWriteHandler,
  requestTerminalWritePipelineProbe,
  settleTerminalWriteStallWatch,
  WRITE_PIPELINE_STALL_CHECK_MS
} from './terminal-write-pipeline-health'

type FakeTerminal = {
  write: (data: string, cb?: () => void) => void
  pendingCallbacks: (() => void)[]
  flush: () => void
  throwOnWrite?: boolean
  dropCallbacks?: boolean
}

function makeTerminal(): FakeTerminal {
  const pendingCallbacks: (() => void)[] = []
  const terminal: FakeTerminal = {
    pendingCallbacks,
    write(_data, cb) {
      if (terminal.throwOnWrite) {
        throw new Error('disposed')
      }
      if (cb && !terminal.dropCallbacks) {
        pendingCallbacks.push(cb)
      }
    },
    flush() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.()
      }
    }
  }
  return terminal
}

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal write pipeline health', () => {
  it('a slow-but-alive pipeline disarms when the probe parses', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    const generation = captureTerminalParseProgressGeneration(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    expect(terminal.pendingCallbacks).toHaveLength(1)
    terminal.flush()
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)

    expect(hasTerminalParseProgressSince(terminal, generation)).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('a throwing discard callback does not suppress the recovery notification', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    const handler = vi.fn()
    const onCertifiedDead = vi.fn(() => {
      throw new TypeError('window.api is gone')
    })
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal, { onCertifiedDead })
    expect(() => vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)).not.toThrow()

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('keeps a requested probe alive while the pipeline makes parse progress', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    requestTerminalWritePipelineProbe(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS / 2)
    settleTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS / 2)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS / 2)
    settleTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS / 2)

    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)

    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    _resetWritePipelineHealthForTests(terminal)
  })
})
