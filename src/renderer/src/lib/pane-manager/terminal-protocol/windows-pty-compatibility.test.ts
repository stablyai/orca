import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { buildWindowsPtyCompatibilityOptions } from './windows-pty-compatibility'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('buildWindowsPtyCompatibilityOptions', () => {
  it('does not mark the row after a full-width Windows status line as wrapped', async () => {
    const options = buildWindowsPtyCompatibilityOptions({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      osRelease: '10.0.19045',
      connectionId: null,
      cwd: 'C:\\repo',
      shellOverride: null,
      executionHostId: 'local'
    })
    const terminal = new Terminal({ cols: 20, rows: 5, ...options })

    await writeTerminal(terminal, `${'─'.repeat(20)}\r\nNEXT\r\n`)

    // Old Windows wrapping falsely joins full-width rows, breaking reported Chinese scrollback.
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('NEXT')
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
  })
})
