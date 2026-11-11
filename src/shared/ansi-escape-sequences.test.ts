import { describe, expect, it } from 'vitest'
import { stripAnsiEscapeSequences } from './ansi-escape-sequences'

describe('ordered linear ANSI stripping', () => {
  it.each([
    ['a\x1b /\x1bc', 'a\x1b /'],
    ['a\x1b /\x00\x1b~b', 'a\x1b /\x00b'],
    ['a\x1b\x1b /0b', 'a\x1bb'],
    ['a\x1b /\x7fb\x1b ', 'a\x1b /\x7fb\x1b ']
  ])('keeps failed generic matches literal before later escapes in %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
  it.each([
    ['\x1b]a\x1b\\KEEP\x1b]b\x07', 'KEEP'],
    ['\x1bPleft\x07right\x1b\\KEEP', 'KEEP'],
    ['\x1bPleft\x1b]hidden\x1b\\right\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b\x1b\\KEEP', 'KEEP'],
    ['\x1b]body\x1b', 'body\x1b'],
    ['\x1b]a\x07KEEP\x1b]b\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x07\x1b\\\x1b]b\x1b\\KEEP', 'KEEP'],
    ['\x1b]a\x9cKEEP\x1bPb\x1b\\TAIL', 'KEEPTAIL'],
    ['\x1b]a\x1b]b\x1bPc', 'abc']
  ])('pins terminator cache edges for %j', (input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
  })
})
