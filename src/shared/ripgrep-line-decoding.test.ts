import { describe, expect, it } from 'vitest'
import { decodeRipgrepLine } from './ripgrep-line-decoding'
import { ripgrepMatchRanges } from './ripgrep-match-offsets'

describe('ripgrep byte line decoding', () => {
  it.each([
    [0xff],
    [0xc0, 0xaf],
    [0xe2, 0x82],
    [0xf0, 0x90, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0x80, 0xbf],
    [0xe0, 0x80, 0xaf]
  ])('maps text after malformed sequence %j like Node UTF8 decoding', (...prefix) => {
    const bytes = Buffer.concat([
      Buffer.from('😀é'),
      Buffer.from(prefix),
      Buffer.from('needle\r\n')
    ])
    const decoded = decodeRipgrepLine({ bytes: bytes.toString('base64') })
    expect(decoded.text).toBe(bytes.toString('utf8').replace(/\n$/, ''))
    expect(decoded.readOffset(bytes.length - 8)).toBe(decoded.text.indexOf('needle'))
    expect(decoded.readOffset(bytes.length - 2)).toBe(decoded.text.indexOf('needle') + 6)
  })

  it('rejects partial replacement boundaries and overlapping ranges without inventing coordinates', () => {
    const decoded = decodeRipgrepLine({
      bytes: Buffer.from([0xe2, 0x82, 0x20, 0x78]).toString('base64')
    })
    let invalid = 0
    const ranges = [
      ...ripgrepMatchRanges(
        decoded.text,
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
          { start: 2, end: 4 },
          { start: 4, end: 4 }
        ],
        decoded.readOffset,
        () => invalid++
      )
    ]
    expect(ranges).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 }
    ])
    expect(invalid).toBe(2)
  })

  it('agrees with Node on all two-byte prefixes followed by ASCII', () => {
    for (let first = 0; first < 256; first++) {
      for (let second = 0; second < 256; second++) {
        const bytes = Buffer.from([first, second, 0x78])
        const decoded = decodeRipgrepLine({ bytes: bytes.toString('base64') })
        expect(decoded.readOffset(2)).toBe(bytes.subarray(0, 2).toString('utf8').length)
      }
    }
  })
})
