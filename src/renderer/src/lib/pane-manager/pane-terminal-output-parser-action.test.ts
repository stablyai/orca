import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_CHUNK_CHARS,
  discardTerminalOutput,
  flushTerminalOutput,
  queueTerminalOutputParsedCallback,
  writeTerminalOutput
} from './pane-terminal-output-scheduler'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

function createTerminal() {
  const pending: (() => void)[] = []
  const events: string[] = []
  const terminal = {
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      pending.push(() => {
        events.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
        callback?.()
      })
    })
  }
  const parse = (): void => {
    for (const callback of pending.splice(0)) {
      callback()
    }
  }
  return { terminal, events, parse }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('queued terminal parser actions', () => {
  it('uses an empty FIFO sentinel without flushing or injecting control bytes', () => {
    const { terminal, events, parse } = createTerminal()
    terminal.write('partial escape')
    queueTerminalOutputParsedCallback(terminal, () => events.push('reset'))
    terminal.write('continuation')
    expect(events).toEqual([])
    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual([
      'partial escape',
      new Uint8Array(0),
      'continuation'
    ])
    parse()
    expect(events).toEqual(['partial escape', '', 'reset', 'continuation'])
  })

  it('keeps hidden output deferred and stops coalescing at the action boundary', () => {
    const { terminal, events, parse } = createTerminal()
    writeTerminalOutput(terminal, 'old cursor', {
      foreground: false,
      onParsed: () => events.push('previous callback')
    })
    queueTerminalOutputParsedCallback(terminal, () => events.push('reset'))
    writeTerminalOutput(terminal, 'new cursor', { foreground: false })
    expect(terminal.write).not.toHaveBeenCalled()
    flushTerminalOutput(terminal)
    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual(['old cursor', 'new cursor'])
    parse()
    expect(events).toEqual(['old cursor', 'previous callback', 'reset', 'new cursor'])
  })

  it('runs the action only after the final slice of its preceding chunk', () => {
    const { terminal, events, parse } = createTerminal()
    const prefix = 'x'.repeat(BACKGROUND_CHUNK_CHARS)
    writeTerminalOutput(terminal, `${prefix}def`, { foreground: false })
    queueTerminalOutputParsedCallback(terminal, () => events.push('reset'))
    flushTerminalOutput(terminal, { maxChars: BACKGROUND_CHUNK_CHARS })
    parse()
    expect(events).toEqual([prefix])
    writeTerminalOutput(terminal, 'later', { foreground: false })
    flushTerminalOutput(terminal)
    parse()
    expect(events).toEqual([prefix, 'def', 'reset', 'later'])
  })

  it('cancels a pending action when its output is discarded for replay', () => {
    const { terminal, events, parse } = createTerminal()
    writeTerminalOutput(terminal, 'discarded', { foreground: false })
    queueTerminalOutputParsedCallback(terminal, () => events.push('stale reset'))
    discardTerminalOutput(terminal)
    terminal.write('snapshot')
    parse()
    expect(events).toEqual(['snapshot'])
  })

  it('contains callback failures without skipping the action or later parses', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { terminal, events, parse } = createTerminal()
    writeTerminalOutput(terminal, 'before', {
      foreground: false,
      onParsed: () => {
        throw new Error('old callback failed')
      }
    })
    writeTerminalOutput(terminal, ' boundary', { foreground: false })
    queueTerminalOutputParsedCallback(terminal, () => {
      events.push('reset')
      throw new Error('refresh failed')
    })
    writeTerminalOutput(terminal, 'after', { foreground: false })
    flushTerminalOutput(terminal)
    expect(parse).not.toThrow()
    expect(events).toEqual(['before boundary', 'reset', 'after'])
  })
})
