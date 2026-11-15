import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { buildBoundedSessionTranscript } from '../../../../../shared/agent-session/context/agent-session-fork-context'
import { readTerminalContextText } from './terminal-context-text'

async function withTerminal<T>(
  data: string,
  cols: number,
  read: (terminal: Terminal) => T
): Promise<T> {
  const terminal = new Terminal({ cols, rows: 4, scrollback: 1000 })
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve))
    return read(terminal)
  } finally {
    terminal.dispose()
  }
}

function contextTextOf(data: string, cols = 40): Promise<string> {
  return withTerminal(data, cols, readTerminalContextText)
}

function transcriptOf(data: string, cols = 40): Promise<string | null> {
  return withTerminal(data, cols, (terminal) =>
    buildBoundedSessionTranscript(readTerminalContextText(terminal))
  )
}

describe('readTerminalContextText', () => {
  it.each([
    ['cursor-forward gaps', 'hello\x1b[1Cworld\x1b[2Cfrom Orca', 'hello world  from Orca'],
    [
      'Korean gaps',
      '안녕하세요\x1b[1C오르카\x1b[2C사용자입니다',
      '안녕하세요 오르카  사용자입니다'
    ],
    ['tab stops', 'key\tvalue\t한국어', 'key     value   한국어'],
    ['styled gaps', '\x1b[41m  red  \x1b[0m gap', 'red   gap'],
    ['hard line breaks', 'one\r\n  two', 'one\n  two']
  ])('keeps %s', async (_, data, expected) => {
    expect(await transcriptOf(data)).toBe(expected)
  })

  it('keeps leading indentation and interior space runs exactly', async () => {
    expect(await contextTextOf('    def f():\r\n        return  1')).toBe(
      '    def f():\n        return  1'
    )
  })

  it('trims trailing padding per logical line and drops blank rows below the output', async () => {
    expect(await contextTextOf(`prompt${' '.repeat(34)}\r\nnext   \r\n`)).toBe('prompt\nnext')
  })

  it('keeps a printed space at a soft-wrap boundary', async () => {
    expect(await contextTextOf('hello world', 6)).toBe('hello world')
    expect(await contextTextOf('abcd ', 5)).toBe('abcd')
  })

  it('drops wide-glyph wrap padding but keeps a cursor-forward gap before a soft wrap', async () => {
    expect(await contextTextOf('abcd가나', 5)).toBe('abcd가나')
    expect(await contextTextOf('abc\x1b[1C가', 5)).toBe('abc 가')
  })

  it('reads only visible columns after a fullscreen TUI shrinks the terminal', async () => {
    const lastLine = await withTerminal('\x1b[?1049habcdefghij', 12, (terminal) => {
      terminal.resize(6, 4)
      return readTerminalContextText(terminal).split('\n').at(-1)
    })
    expect(lastLine).toBe('abcdef')
  })

  it('keeps normal-buffer history when a fullscreen TUI is active', async () => {
    expect(await transcriptOf('User: build X\r\n\x1b[?1049h\x1b[HAgent\x1b[2Cworking')).toBe(
      'User: build X\nAgent  working'
    )
  })
})
