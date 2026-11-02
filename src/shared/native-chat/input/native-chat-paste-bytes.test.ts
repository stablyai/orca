import { describe, expect, it } from 'vitest'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes
} from './native-chat-paste-bytes'

const BEGIN = '\x1b[200~'
const END = '\x1b[201~'

describe('buildNativeChatPasteBytes', () => {
  it('single-line text has no trailing submit (Enter is written separately)', () => {
    expect(buildNativeChatPasteBytes('hello world')).toBe('hello world')
    expect(buildNativeChatPasteBytes('hello world')).not.toContain('\r')
  })

  it('multi-line text is bracketed-paste wrapped with NO trailing submit', () => {
    const text = 'line one\r\nline two\nline three'
    expect(buildNativeChatPasteBytes(text)).toBe(`${BEGIN}line one\rline two\rline three${END}`)
  })

  it('treats a trailing newline as multi-line', () => {
    expect(buildNativeChatPasteBytes('a\n')).toBe(`${BEGIN}a\r${END}`)
  })

  it('sanitizes an embedded bracketed-paste end and bare ESC before framing', () => {
    const malicious = 'before\nmid\x1b[201~ rm -rf /\x1b tail'
    const bytes = buildNativeChatPasteBytes(malicious)
    expect(bytes.startsWith(BEGIN)).toBe(true)
    expect(bytes.endsWith(END)).toBe(true)
    const inner = bytes.slice(BEGIN.length, bytes.length - END.length)
    expect(inner).not.toContain('\x1b')
    expect(inner).toContain('␛[201~')
  })

  it('neutralizes a stray ESC in the single-line branch', () => {
    expect(buildNativeChatPasteBytes('hi\x1b there')).toBe('hi␛ there')
  })

  it('frames single-line text over 1 KiB of UTF-8 so agents keep every read (#13332)', () => {
    const atBoundary = 'é'.repeat(512)
    const overBoundary = `${atBoundary}x`
    expect(buildNativeChatPasteBytes(atBoundary)).toBe(atBoundary)
    expect(buildNativeChatPasteBytes(overBoundary)).toBe(`${BEGIN}${overBoundary}${END}`)
    // Each ESC becomes a 3-byte ␛, so the sent length, not the typed one, decides.
    expect(buildNativeChatPasteBytes('\x1b'.repeat(400))).toBe(`${BEGIN}${'␛'.repeat(400)}${END}`)
  })
})

describe('buildNativeChatImagePasteBytes', () => {
  it('always bracket-pastes the image path so agent TUIs attach it as an image', () => {
    expect(buildNativeChatImagePasteBytes('/tmp/orca-paste-image.png')).toBe(
      `${BEGIN}/tmp/orca-paste-image.png${END}`
    )
  })
})
