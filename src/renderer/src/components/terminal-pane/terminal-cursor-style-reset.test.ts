import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetTerminalCursorStyle } from './terminal-cursor-style-reset'
import { queueTerminalOutputParsedCallback } from '@/lib/pane-manager/pane-terminal-output-scheduler'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const terminals: Terminal[] = []
function createTerminal(): Terminal {
  const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
  terminals.push(terminal)
  return terminal
}
function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}
function line(terminal: Terminal): string {
  return terminal.buffer.active.getLine(0)?.translateToString(true) ?? ''
}
function cursorModes(terminal: Terminal): { style: unknown; blink: unknown } {
  if (!('_core' in terminal)) {
    throw new Error('Missing xterm core')
  }
  const core = terminal._core
  if (!core || typeof core !== 'object' || !('coreService' in core)) {
    throw new Error('Missing service')
  }
  const service = core.coreService
  if (!service || typeof service !== 'object' || !('decPrivateModes' in service)) {
    throw new Error('Missing modes')
  }
  const modes = service.decPrivateModes
  if (
    !modes ||
    typeof modes !== 'object' ||
    !('cursorStyle' in modes) ||
    !('cursorBlink' in modes)
  ) {
    throw new Error('Missing cursor modes')
  }
  return { style: modes.cursorStyle, blink: modes.cursorBlink }
}
afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.restoreAllMocks()
})

describe('parser-neutral idle cursor reset', () => {
  it('reproduces the display-only color suffix left by an injected cursor escape', async () => {
    const terminal = createTerminal()
    const input = vi.fn()
    terminal.onData(input)
    await write(terminal, '测试\x1b[38;2;42;')
    await write(terminal, '\x1b[0 q')
    await write(terminal, '1;116m阅')
    expect(line(terminal)).toBe('测试1;116m阅')
    expect(input).not.toHaveBeenCalled()
    await write(terminal, '\r\x1b[2K测试阅')
    expect(line(terminal)).toBe('测试阅')
  })

  it.each([
    ['SGR', '\x1b[38;2;42;', '1;116m'],
    ['C1 SGR', '\u009b38;2;42;', '1;116m'],
    ['OSC', '\x1b]2;partial', ' title\x07'],
    ['DCS', '\x1bPignored', ' payload\x1b\\'],
    ['long OSC', `\x1b]2;${'x'.repeat(5000)}`, '\x07']
  ])('does not abort a split %s when resetting the cursor', async (_name, prefix, suffix) => {
    const terminal = createTerminal()
    const input = vi.fn()
    terminal.onData(input)
    // Keep all three writes pending to exercise xterm's actual FIFO callback boundary.
    terminal.write(`\x1b[6 q测试${prefix}`)
    queueTerminalOutputParsedCallback(terminal, () => resetTerminalCursorStyle(terminal))
    const parsed = write(terminal, `${suffix}阅`)
    terminal.resize(81, 4)
    await parsed
    expect(line(terminal)).toBe('测试阅')
    expect(input).not.toHaveBeenCalled()
    expect(cursorModes(terminal)).toEqual({ style: undefined, blink: undefined })
  })

  it('preserves split UTF-8 and all callbacks when a resize flushes pending writes', async () => {
    const terminal = createTerminal()
    const events: string[] = []
    terminal.write(new Uint8Array([0xe9]), () => events.push('prefix'))
    queueTerminalOutputParsedCallback(terminal, () => {
      resetTerminalCursorStyle(terminal)
      events.push('reset')
    })
    const parsed = new Promise<void>((resolve) => {
      terminal.write(new Uint8Array([0x98, 0x85]), () => {
        events.push('suffix')
        resolve()
      })
    })
    terminal.resize(81, 4)
    await parsed
    expect(line(terminal)).toBe('阅')
    expect(events).toEqual(['prefix', 'reset', 'suffix'])
  })

  it('lets a newer application cursor style win after the reset', async () => {
    const terminal = createTerminal()
    terminal.write('\x1b[6 q')
    queueTerminalOutputParsedCallback(terminal, () => resetTerminalCursorStyle(terminal))
    await write(terminal, '\x1b[4 q')
    expect(cursorModes(terminal)).toEqual({ style: 'underline', blink: false })
  })

  it('honors the configured cursor shape and blink after clearing application overrides', async () => {
    const terminal = createTerminal()
    terminal.options.cursorStyle = 'underline'
    terminal.options.cursorBlink = false
    await write(terminal, '\x1b[5 q')
    expect(cursorModes(terminal)).toEqual({ style: 'bar', blink: true })
    resetTerminalCursorStyle(terminal)
    expect(cursorModes(terminal)).toEqual({ style: undefined, blink: undefined })
    expect(terminal.options.cursorStyle).toBe('underline')
    expect(terminal.options.cursorBlink).toBe(false)
  })

  it('does not inject an escape when private internals are unavailable', () => {
    const terminal = createTerminal()
    const refresh = vi.fn()
    resetTerminalCursorStyle({ buffer: terminal.buffer, rows: terminal.rows, refresh })
    expect(refresh).not.toHaveBeenCalled()
  })
})
