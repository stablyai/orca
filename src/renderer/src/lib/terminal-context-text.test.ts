import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { captureTerminalContextText } from './terminal-context-text'

describe('terminal context text', () => {
  it.each([
    ['English gaps', 'hello\x1b[1Cworld\x1b[2Cfrom Orca', 80, 'hello world  from Orca'],
    [
      'Korean gaps',
      '안녕하세요\x1b[1C오르카\x1b[2C사용자입니다',
      80,
      '안녕하세요 오르카  사용자입니다'
    ],
    ['tabs', 'key\tvalue\t한국어', 80, 'key     value   한국어'],
    ['wrapped word space', 'hello world', 6, 'hello world'],
    ['wide wrap padding', 'abcd가나', 5, 'abcd가나'],
    ['space before wide glyph', 'abc 가나', 5, 'abc 가나'],
    ['hard line break', 'one\r\ntwo', 10, 'one\ntwo'],
    ['indentation', '    code', 20, '    code'],
    [
      'normal history with alternate content',
      'User requirement: X\r\n\x1b[?1049hAgent working',
      40,
      'User requirement: X\n\nAgent working'
    ],
    [
      'normal history with empty alternate',
      'User requirement: X\r\n\x1b[?1049h',
      40,
      'User requirement: X'
    ]
  ] as const)('preserves %s', async (_, input, cols, expected) => {
    const terminal = new Terminal({ cols, rows: 3, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => terminal.write(input, resolve))
      expect(captureTerminalContextText(terminal).trimEnd()).toBe(expected)
    } finally {
      terminal.dispose()
    }
  })
})
