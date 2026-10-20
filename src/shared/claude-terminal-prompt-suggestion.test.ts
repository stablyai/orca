import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { expect, it } from 'vitest'
import { readClaudeTerminalPromptSuggestion } from './claude-terminal-prompt-suggestion'

const capture = readFileSync(
  join(__dirname, '../main/runtime/__fixtures__/claude-prompt-suggestion.txt'),
  'utf8'
)
const write = (terminal: Terminal, text: string): Promise<void> =>
  new Promise((resolve) => terminal.write(text, resolve))

it('reads the captured Claude 2.1.280 suggestion without treating it as typed input', async () => {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  try {
    await write(terminal, capture)
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBe('yes, write tests for both')
    // The same text typed by the user has undimmed cells, even at Home.
    await write(terminal, '\x1b[28;3H\x1b[0myes, write tests for both\x1b[28;3H')
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
    await write(terminal, '\x1b[2myes, write tests for both\x1b[0m\x1b[28;4H')
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
  } finally {
    terminal.dispose()
  }
})

it('rejects stock placeholders, hidden cursors, incomplete frames and monochrome text', async () => {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  try {
    await write(terminal, capture)
    await write(terminal, '\x1b[28;3H\x1b[K\x1b[2mTry "write a test"\x1b[0m\x1b[28;3H')
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
    await write(terminal, capture)
    await write(terminal, '\x1b[?25l')
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
    await write(terminal, '\x1b[?25h\x1b[29;1H\x1b[K\x1b[28;3H')
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
    await write(
      terminal,
      capture.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    )
    expect(readClaudeTerminalPromptSuggestion(terminal)).toBeNull()
  } finally {
    terminal.dispose()
  }
})
