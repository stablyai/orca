import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { writeForegroundTerminalChunk } from './pane-terminal-foreground-render-settle'
import {
  discardTerminalOutput,
  flushTerminalOutput,
  writeTerminalOutput
} from './pane-terminal-output-scheduler'
import { isTerminalOnAlternateScreen } from './terminal-output-screen'

describe('terminal output screen', () => {
  it('tracks a screen sequence split across a parsed write and a pending write', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => {
        writeForegroundTerminalChunk(terminal, '\x1b[?10', { onParsed: resolve })
      })

      const parsed = new Promise<void>((resolve) => {
        writeForegroundTerminalChunk(terminal, '49h', { onParsed: resolve })
      })

      expect(terminal.buffer.active.type).toBe('normal')
      expect(isTerminalOnAlternateScreen(terminal)).toBe(true)
      await parsed
      expect(terminal.buffer.active.type).toBe('alternate')
    } finally {
      terminal.dispose()
    }
  })

  it('counts submitted background switches but not discarded scheduler output', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    try {
      writeTerminalOutput(terminal, '\x1b[?1049h', { foreground: false })
      discardTerminalOutput(terminal)
      expect(isTerminalOnAlternateScreen(terminal)).toBe(false)

      writeTerminalOutput(terminal, '\x1b[?1049h', { foreground: false })
      flushTerminalOutput(terminal)

      expect(terminal.buffer.active.type).toBe('normal')
      expect(isTerminalOnAlternateScreen(terminal)).toBe(true)
      await new Promise<void>((resolve) => terminal.write('', resolve))
      expect(terminal.buffer.active.type).toBe('alternate')
    } finally {
      discardTerminalOutput(terminal)
      terminal.dispose()
    }
  })

  it.each(['\x1b[?1049l', '\x1b[?1047l', '\x1b[?47l', '\x1bc'])(
    'includes replay and queued normal-screen transitions: %j',
    async (leave) => {
      const terminal = new Terminal({ allowProposedApi: true })
      try {
        await new Promise<void>((resolve) => {
          writeForegroundTerminalChunk(terminal, '\x1b[?1049h', { onParsed: resolve })
        })
        const parsed = new Promise<void>((resolve) => {
          writeForegroundTerminalChunk(terminal, leave, { onParsed: resolve })
        })

        expect(terminal.buffer.active.type).toBe('alternate')
        expect(isTerminalOnAlternateScreen(terminal)).toBe(false)
        await parsed
        expect(terminal.buffer.active.type).toBe('normal')
      } finally {
        terminal.dispose()
      }
    }
  )
})
