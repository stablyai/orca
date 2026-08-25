import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  frameMultilineTerminalPasteText,
  isMultilineTerminalPasteText,
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-bytes'

const ESCAPE = '\u001b'
const ESCAPE_SUBSTITUTE = '\u241b'

describe('frameMultilineTerminalPasteText', () => {
  it('frames a multi-line body and leaves no raw newline for the TUI to submit on', () => {
    const framed = frameMultilineTerminalPasteText('first line\nsecond line')

    expect(framed.startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(framed.endsWith(BRACKETED_PASTE_END)).toBe(true)
    expect(framed).not.toContain('\n')
    expect(framed).toContain('first line\rsecond line')
  })

  it('returns single-line text byte-identical', () => {
    expect(frameMultilineTerminalPasteText('just one line')).toBe('just one line')
    expect(frameMultilineTerminalPasteText('')).toBe('')
  })

  it('never frames a bare submit key', () => {
    // The slash-command and selector transports write a lone CR through the same
    // seam; framed, it is paste content and the TUI never commits.
    expect(frameMultilineTerminalPasteText('\r')).toBe('\r')
  })

  it('neutralizes an embedded escape so a pasted end marker cannot close the frame early', () => {
    const framed = frameMultilineTerminalPasteText(`before\n${ESCAPE}[201~after`)

    expect(framed.indexOf(BRACKETED_PASTE_END)).toBe(framed.length - BRACKETED_PASTE_END.length)
    expect(framed).toContain(`${ESCAPE_SUBSTITUTE}[201~after`)
  })
})

describe('framed payload size', () => {
  it('grows by the delimiters plus two bytes per escape, and shrinks per CRLF', () => {
    // The host enforces its byte ceiling on what we send, so the accounting has
    // to be honest in both directions.
    const delimiters = Buffer.byteLength(BRACKETED_PASTE_START + BRACKETED_PASTE_END, 'utf8')
    expect(delimiters).toBe(12)

    const crlf = 'a\r\nb'
    expect(Buffer.byteLength(wrapTerminalBracketedPasteText(crlf), 'utf8')).toBe(
      Buffer.byteLength(crlf, 'utf8') - 1 + delimiters
    )

    const withEscape = `a\n${ESCAPE}b`
    expect(Buffer.byteLength(wrapTerminalBracketedPasteText(withEscape), 'utf8')).toBe(
      Buffer.byteLength(withEscape, 'utf8') + 2 + delimiters
    )
  })
})

describe('isMultilineTerminalPasteText', () => {
  it('detects both line-ending forms', () => {
    expect(isMultilineTerminalPasteText('a\nb')).toBe(true)
    expect(isMultilineTerminalPasteText('a\rb')).toBe(true)
    expect(isMultilineTerminalPasteText('ab')).toBe(false)
  })
})

describe('sanitizeBracketedPasteText', () => {
  it('leaves escape-free text untouched', () => {
    expect(sanitizeBracketedPasteText('plain')).toBe('plain')
  })
})
