import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildTerminalClipboardPasteText,
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste-text'

describe('buildTerminalClipboardPasteText', () => {
  it('leaves text unframed when bracketed paste mode is off', () => {
    expect(buildTerminalClipboardPasteText('hello', { bracketedPasteMode: false })).toBe('hello')
    expect(buildTerminalClipboardPasteText('hello', undefined)).toBe('hello')
  })

  it('frames when bracketed paste mode is on, including alt-screen TUIs', () => {
    const framed = buildTerminalClipboardPasteText('hello\nworld', {
      bracketedPasteMode: true,
      altScreen: true
    })
    expect(framed).toBe(`${BRACKETED_PASTE_START}hello\rworld${BRACKETED_PASTE_END}`)
  })

  it('neutralizes an embedded paste-end so trailing bytes stay inside the frame', () => {
    const framed = buildTerminalClipboardPasteText('before\x1b[201~after', {
      bracketedPasteMode: true
    })
    const inner = framed.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
    expect(inner).not.toContain('\x1b')
    expect(inner).toContain('␛[201~')
  })
})

describe('wrapTerminalBracketedPasteText', () => {
  it('normalizes LF to CR inside the frame', () => {
    expect(wrapTerminalBracketedPasteText('a\nb')).toBe(
      `${BRACKETED_PASTE_START}a\rb${BRACKETED_PASTE_END}`
    )
  })
})

describe('sanitizeBracketedPasteText', () => {
  it('replaces bare ESC with the printable substitute', () => {
    expect(sanitizeBracketedPasteText('hi\x1b there')).toBe('hi␛ there')
  })
})
