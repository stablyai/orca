import { describe, expect, it } from 'vitest'
import {
  buildNativeChatAttachmentBytes,
  buildNativeChatAttachmentWrites,
  buildNativeChatPasteBytes,
  formatNativeChatFileReference,
  isMultilineDraft,
  needsBracketedFraming
} from './native-chat-paste-bytes'

const BEGIN = '\x1b[200~'
const END = '\x1b[201~'

describe('formatNativeChatFileReference', () => {
  it('leaves a simple path unquoted', () => {
    expect(formatNativeChatFileReference('/tmp/a.png')).toBe('@/tmp/a.png')
  })

  it('quotes a path containing whitespace', () => {
    expect(formatNativeChatFileReference('/tmp/a b.png')).toBe('@"/tmp/a b.png"')
  })

  it('quotes a path containing a quote even without whitespace', () => {
    // Why: escaping a quote only makes sense inside a quoted token; emitting
    // `@/tmp/say\"hi.png` would hand the parser a stray escape.
    expect(formatNativeChatFileReference('/tmp/say"hi.png')).toBe('@"/tmp/say\\"hi.png"')
  })

  it('quotes and escapes a path containing both', () => {
    expect(formatNativeChatFileReference('/tmp/a "b".png')).toBe('@"/tmp/a \\"b\\".png"')
  })
})

describe('needsBracketedFraming', () => {
  it('frames CR and LF so a pasted value cannot submit the turn', () => {
    expect(needsBracketedFraming('a\rb')).toBe(true)
    expect(needsBracketedFraming('a\nb')).toBe(true)
  })

  it('frames other control bytes that would act as keys', () => {
    expect(needsBracketedFraming('a\tb')).toBe(true)
    expect(needsBracketedFraming('a\u0000b')).toBe(true)
    expect(needsBracketedFraming('a\u007fb')).toBe(true)
  })

  it('excludes ESC, which sanitization neutralises instead of framing', () => {
    expect(needsBracketedFraming('a\u001bb')).toBe(false)
  })

  it('does not frame ordinary text, including ordinary spaces', () => {
    expect(needsBracketedFraming('/tmp/a b.png')).toBe(false)
    expect(needsBracketedFraming('plain')).toBe(false)
  })

  it('is a superset of the multi-line trigger', () => {
    expect(isMultilineDraft('a\nb')).toBe(true)
    expect(needsBracketedFraming('a\nb')).toBe(true)
    // A tab is not multi-line, but still must not go out as keystrokes.
    expect(isMultilineDraft('a\tb')).toBe(false)
    expect(needsBracketedFraming('a\tb')).toBe(true)
  })
})

describe('buildNativeChatAttachmentBytes', () => {
  it('bracket-pastes the raw path for agents with an image-paste gesture', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/a.png', 'image-paste')).toBe(
      `${BEGIN}/tmp/a.png${END}`
    )
  })

  it('leaves an ordinary file reference unframed', () => {
    expect(buildNativeChatAttachmentBytes('/tmp/a.png', 'file-reference')).toBe('@/tmp/a.png')
  })

  it('frames a file reference whose name holds a control byte', () => {
    // Why: a TAB is whitespace, so the reference is quoted as well as framed.
    expect(buildNativeChatAttachmentBytes('/tmp/a\tb.png', 'file-reference')).toBe(
      `${BEGIN}@"/tmp/a\tb.png"${END}`
    )
  })

  it('frames a file reference whose name holds CR/LF so it cannot submit early', () => {
    const bytes = buildNativeChatAttachmentBytes('/tmp/a\rb.png', 'file-reference')
    expect(bytes.startsWith(BEGIN)).toBe(true)
    expect(bytes.endsWith(END)).toBe(true)
    // The submit byte must not survive outside the frame.
    expect(bytes.slice(BEGIN.length, bytes.length - END.length)).not.toBe('\r')
  })

  it('keeps sanitizing an unframed reference so a stray escape cannot reach the composer', () => {
    // Why: ESC alone must stay unframed but neutralised, exactly as the escape
    // case asserted in native-chat-send.test.ts.
    const bytes = buildNativeChatAttachmentBytes('/tmp/a\u001bb.png', 'file-reference')
    expect(bytes).toBe('@/tmp/a\u241bb.png')
    expect(bytes).not.toContain('\u001b')
  })
})

describe('buildNativeChatAttachmentWrites', () => {
  it('separates every image paste pair and the trailing text', () => {
    expect(buildNativeChatAttachmentWrites(['/a.png', '/b.png'], 'image-paste', true)).toEqual([
      `${BEGIN}/a.png${END}`,
      `${BEGIN}/b.png${END} `
    ])
  })

  it('separates references from each other and from trailing text', () => {
    expect(buildNativeChatAttachmentWrites(['/a.png', '/b.png'], 'file-reference', true)).toEqual([
      '@/a.png ',
      '@/b.png '
    ])
  })

  it('does not add a trailing space when nothing follows', () => {
    expect(buildNativeChatAttachmentWrites(['/a.png'], 'file-reference', false)).toEqual([
      '@/a.png'
    ])
  })
})

describe('buildNativeChatPasteBytes', () => {
  it('is unchanged for plain and multi-line bodies', () => {
    expect(buildNativeChatPasteBytes('hello')).toBe('hello')
    expect(buildNativeChatPasteBytes('a\nb')).toBe(`${BEGIN}a\rb${END}`)
  })
})
