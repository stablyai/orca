import { describe, expect, it } from 'vitest'
import { restoreMarkdownSourceEol } from './rich-markdown-source-reconcile'

describe('rich Markdown source line-ending allocation', () => {
  it.each([
    ['empty source', '', '\n'],
    ['no line ending', 'text', '\n'],
    ['LF only', 'a\nb\n', '\n'],
    ['CRLF only', 'a\r\nb\r\n', '\r\n'],
    ['lone CR only', 'a\rb\r', '\n'],
    ['lone CR before CRLF', 'a\r\r\nb', '\r\n'],
    ['CRLF first in a tie', 'a\r\nb\n', '\r\n'],
    ['LF first in a tie', 'a\nb\r\n', '\r\n'],
    ['LF majority', 'a\nb\r\nc\n', '\n'],
    ['CRLF majority', 'a\r\nb\nc\r\n', '\r\n'],
    ['Unicode separators', '\u2028\u2029', '\n'],
    ['lone surrogates and NUL', '\ud800\n\udfff\0', '\n']
  ])('preserves the existing decision for %s', (_name, source, eol) => {
    const content = 'new\r\nline\n\ud800\udfff\0'
    expect(restoreMarkdownSourceEol(content, source)).toBe(`new${eol}line${eol}\ud800\udfff\0`)
  })
})
