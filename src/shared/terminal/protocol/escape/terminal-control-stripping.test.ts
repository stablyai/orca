import { expect, it } from 'vitest'
import { stripTerminalControl } from './terminal-control-stripping'

it('drops control-string payloads and keeps the text around them', () => {
  expect(stripTerminalControl('before\x1b]0;window title\x07after')).toBe('beforeafter')
  expect(stripTerminalControl('\x1b]8;;https://example.test\x1b\\label\x1b]8;;\x1b\\')).toBe(
    'label'
  )
  expect(stripTerminalControl('a\x1bPdevice\x07payload\x1b\\b\x1b_private\x1b\\c')).toBe('abc')
  expect(stripTerminalControl('a\x1b]0;title\x18b\x1bXhidden\x1b[31mc')).toBe('abc')
  expect(stripTerminalControl('before\x1b]0;unfinished\n')).toBe('before')
})
