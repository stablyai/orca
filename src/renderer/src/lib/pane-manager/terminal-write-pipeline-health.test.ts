import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  armTerminalWriteStallWatch,
  isTerminalWritePipelineCertifiedDead,
  notifyUndeliverableWrite,
  registerUndeliverableWriteHandler,
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
  it('a settled write never probes or notifies', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    settleTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)

    expect(terminal.pendingCallbacks).toHaveLength(0)
    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('a slow-but-alive pipeline disarms when the probe parses', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // Probe write queued; the pipeline is alive and parses it.
    expect(terminal.pendingCallbacks).toHaveLength(1)
    terminal.flush()
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)

    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('certifies dead and notifies when the probe never parses (wedged pipeline)', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    const handler = vi.fn()
    const onCertifiedDead = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal, { onCertifiedDead })
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(onCertifiedDead).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
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

  it('a throwing handler never escapes the certification timer', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    registerUndeliverableWriteHandler(terminal, () => {
      throw new TypeError('partial store surface')
    })

    armTerminalWriteStallWatch(terminal)
    expect(() => vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)).not.toThrow()

    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('certifies dead immediately when the probe write throws (disposed terminal)', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    terminal.throwOnWrite = true
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('a settle landing between probe and certification cancels the pending verdict', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // The stalled completion finally arrives while the probe is pending.
    settleTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)

    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('notifies at most once per terminal instance', () => {
    const terminal = makeTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    notifyUndeliverableWrite(terminal, 'replay-wedged')
    notifyUndeliverableWrite(terminal, 'write-stalled')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('replay-wedged')
    _resetWritePipelineHealthForTests(terminal)
  })

  it('does not re-arm a certified-dead terminal', () => {
    vi.useFakeTimers()
    const terminal = makeTerminal()
    terminal.dropCallbacks = true
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)
    expect(handler).toHaveBeenCalledTimes(1)

    armTerminalWriteStallWatch(terminal)
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).toHaveBeenCalledTimes(1)
    _resetWritePipelineHealthForTests(terminal)
  })

  it('unregistering a handler stops notifications', () => {
    const terminal = makeTerminal()
    const handler = vi.fn()
    const unregister = registerUndeliverableWriteHandler(terminal, handler)
    unregister()

    notifyUndeliverableWrite(terminal, 'write-stalled')

    expect(handler).not.toHaveBeenCalled()
    _resetWritePipelineHealthForTests(terminal)
  })
})
