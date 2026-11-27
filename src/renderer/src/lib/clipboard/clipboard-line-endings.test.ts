import { describe, expect, it } from 'vitest'
import {
  CODE_CLIPBOARD_LINE_ENDING_MAX_LENGTH,
  toCodeClipboardText,
  toLfPastedText
} from './clipboard-line-endings'

describe('toCodeClipboardText', () => {
  it('uses CRLF on Windows without doubling existing CRLF', () => {
    expect(toCodeClipboardText('a\nb\r\nc\n', true)).toBe('a\r\nb\r\nc\r\n')
  })

  it('leaves text unchanged elsewhere', () => {
    expect(toCodeClipboardText('a\nb\r\nc\n', false)).toBe('a\nb\r\nc\n')
  })

  it('leaves oversized text unchanged on Windows', () => {
    const text = '\n'.repeat(CODE_CLIPBOARD_LINE_ENDING_MAX_LENGTH + 1)
    expect(toCodeClipboardText(text, true)).toBe(text)
  })
})

describe('toLfPastedText', () => {
  it('turns CRLF into LF', () => {
    expect(toLfPastedText('a\r\nb\nc\r\n')).toBe('a\nb\nc\n')
  })

  it('keeps a lone CR', () => {
    expect(toLfPastedText('10%\r50%\r100%\r\ndone')).toBe('10%\r50%\r100%\ndone')
  })
})
