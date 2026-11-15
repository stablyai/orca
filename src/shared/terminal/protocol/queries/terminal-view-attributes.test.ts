/** Main’s hidden-PTY color replies must match the bundled renderer xterm’s XParseColor grammar byte-for-byte. */
import { describe, expect, it } from 'vitest'
import { formatXColorRgbSpec, parseXColorSpec } from './terminal-view-attributes'

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
