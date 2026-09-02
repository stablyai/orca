/**
 * View-attribute bridge (terminal-query-authority.md §View-attribute bridge):
 * the XParseColor mirrors must match the bundled xterm grammar exactly —
 * main's replies for hidden PTYs must be byte-identical to a visible
 * renderer xterm's.
 */
import { describe, expect, it } from 'vitest'
import {
  formatXColorRgbSpec,
  parseXColorSpec,
  terminalViewAttributesEqual,
  validateTerminalViewAttributes,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from './terminal-view-attributes'

describe('parseXColorSpec', () => {
  // Scaling fixtures mirror XParseColor.parseColor: h|hh|hhh|hhhh channels
  // scale from their base (15/255/4095/65535) to 8 bit.
  it.each([
    ['rgb:f/f/f', [255, 255, 255]],
    ['rgb:0/8/f', [0, 136, 255]],
    ['rgb:ff/00/80', [255, 0, 128]],
    ['rgb:fff/000/888', [255, 0, 136]],
    ['rgb:ffff/0000/8888', [255, 0, 136]],
    ['RGB:FF/00/80', [255, 0, 128]],
    ['#abc', [0xa0, 0xb0, 0xc0]],
    ['#aabbcc', [0xaa, 0xbb, 0xcc]],
    ['#aaabbbccc', [0xaa, 0xbb, 0xcc]],
    ['#aaaabbbbcccc', [0xaa, 0xbb, 0xcc]]
  ])('parses %s like xterm', (spec, expected) => {
    expect(parseXColorSpec(spec)).toEqual(expected)
  })

  it.each([
    ['', 'empty'],
    ['red', 'named colors (xterm rejects them too)'],
    ['rgb:ff/ff', 'missing channel'],
    ['rgb:ggg/000/000', 'non-hex'],
    ['#abcd', 'hash length 4 is not a valid xparsecolor width'],
    ['rgbi:1/1/1', 'rgbi is unsupported']
  ])('rejects %s — %s', (spec) => {
    expect(parseXColorSpec(spec)).toBeNull()
  })
})

describe('formatXColorRgbSpec', () => {
  it('reports 16-bit channels by doubling the 8-bit byte (toRgbString parity)', () => {
    expect(formatXColorRgbSpec([0x1e, 0x1e, 0x2e])).toBe('rgb:1e1e/1e1e/2e2e')
    expect(formatXColorRgbSpec([0, 8, 255])).toBe('rgb:0000/0808/ffff')
  })
})

describe('validateTerminalViewAttributes', () => {
  const valid = (): TerminalViewAttributes => ({
    foreground: [1, 2, 3],
    background: [4, 5, 6],
    cursor: [7, 8, 9],
    ansi: Array.from({ length: 256 }, (_, i) => [i % 256, 0, 0] as TerminalViewRgb),
    colorSchemeMode: 'dark',
    cursorStyle: 'block',
    cursorBlink: true
  })

  it('accepts and normalizes a well-formed payload', () => {
    const attrs = validateTerminalViewAttributes(valid())
    expect(attrs).not.toBeNull()
    expect(attrs?.ansi).toHaveLength(256)
    expect(attrs?.colorSchemeMode).toBe('dark')
  })

  it.each([
    ['null payload', null],
    ['missing foreground', { ...valid(), foreground: undefined }],
    ['short triple', { ...valid(), background: [1, 2] }],
    ['out-of-range channel', { ...valid(), cursor: [0, 0, 300] }],
    ['non-integer channel', { ...valid(), cursor: [0, 0, 1.5] }],
    ['short palette', { ...valid(), ansi: valid().ansi.slice(0, 16) }],
    ['bad palette entry', { ...valid(), ansi: [...valid().ansi.slice(0, 255), 'red'] }],
    ['bad mode', { ...valid(), colorSchemeMode: 'auto' }],
    ['bad cursor style', { ...valid(), cursorStyle: 'beam' }],
    ['non-boolean blink', { ...valid(), cursorBlink: 1 }]
  ])('rejects %s', (_label, payload) => {
    expect(validateTerminalViewAttributes(payload)).toBeNull()
  })
})

describe('terminalViewAttributesEqual', () => {
  // The store's idempotence gate: a deep-equal snapshot from a fresh renderer
  // process must compare equal so the re-push never fans out as a theme apply.
  const snapshot = (): TerminalViewAttributes => ({
    foreground: [1, 2, 3],
    background: [4, 5, 6],
    cursor: [7, 8, 9],
    ansi: Array.from({ length: 256 }, (_, i) => [i % 256, 0, 0] as TerminalViewRgb),
    colorSchemeMode: 'dark',
    cursorStyle: 'block',
    cursorBlink: true
  })

  it('treats two independently built identical snapshots as equal', () => {
    expect(terminalViewAttributesEqual(snapshot(), snapshot())).toBe(true)
  })

  it.each([
    ['foreground', { ...snapshot(), foreground: [1, 2, 4] as TerminalViewRgb }],
    ['background', { ...snapshot(), background: [0, 0, 0] as TerminalViewRgb }],
    ['cursor', { ...snapshot(), cursor: [7, 8, 10] as TerminalViewRgb }],
    [
      'an ansi entry',
      { ...snapshot(), ansi: snapshot().ansi.map((rgb, i) => (i === 200 ? [9, 9, 9] : rgb)) }
    ],
    ['colorSchemeMode', { ...snapshot(), colorSchemeMode: 'light' as const }],
    ['cursorStyle', { ...snapshot(), cursorStyle: 'bar' as const }],
    ['cursorBlink', { ...snapshot(), cursorBlink: false }]
  ])('detects a change in %s', (_label, changed) => {
    expect(terminalViewAttributesEqual(snapshot(), changed as TerminalViewAttributes)).toBe(false)
  })
})
