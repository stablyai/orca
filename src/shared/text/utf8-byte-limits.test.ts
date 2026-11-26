import { describe, expect, it } from 'vitest'
import { clampUtf8TextPrefix, getUtf8ChunkEndIndex } from './utf8-byte-limits'

// Node 24/26 V8 optimization can pair a slice’s trailing high surrogate with a parent unit outside the slice.
// Force tier-up on a rope cut mid-pair to expose the intermittent one-byte overcount.
const SLICE_BOUNDARY_PARENT_UNITS = [
  0x72, 0x2e6, 0x7b, 0x54, 0xda9b, 0x568, 0x52, 0x26, 0x46, 0xc15b, 0x7, 0x768, 0xd9f6, 0xdcde
]
// V8 only creates a sliced string (rather than copying) at 13 code units or more.
const SLICE_BOUNDARY_UNITS = 13
const TIER_UP_ITERATIONS = 200_000

function buildSliceEndingInLoneHighSurrogate(): string {
  let text = ''
  for (const unit of SLICE_BOUNDARY_PARENT_UNITS) {
    text += String.fromCharCode(unit)
  }
  return text.slice(0, SLICE_BOUNDARY_UNITS)
}

describe('scanning a prefix slice whose parent continues past the slice', () => {
  const sliced = buildSliceEndingInLoneHighSurrogate()

  it('keeps the whole slice when clamping to its true byte length in every JIT tier', () => {
    const limit = Buffer.byteLength(sliced, 'utf8')
    const observed = new Set<number>()
    for (let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1) {
      observed.add(clampUtf8TextPrefix(sliced, limit).length)
    }
    expect([...observed]).toEqual([SLICE_BOUNDARY_UNITS])
  })
})

describe('getUtf8ChunkEndIndex', () => {
  it.each([
    { name: 'ASCII', text: 'abcdef', maxBytes: 3, endIndex: 3 },
    { name: 'multibyte characters', text: 'aé中z', maxBytes: 6, endIndex: 3 }
  ])('respects the byte budget for $name', ({ text, maxBytes, endIndex }) => {
    expect(getUtf8ChunkEndIndex(text, 0, maxBytes)).toBe(endIndex)
  })

  it('never splits valid surrogate pairs', () => {
    expect(getUtf8ChunkEndIndex('a😀b', 0, 4)).toBe(1)
    expect(getUtf8ChunkEndIndex('a😀b', 1, 4)).toBe(3)
  })

  it.each(['\ud800a', '\udc00a'])('counts a lone surrogate as three bytes', (text) => {
    expect(getUtf8ChunkEndIndex(text, 0, 3)).toBe(1)
  })

  it('starts measuring at the requested offset', () => {
    expect(getUtf8ChunkEndIndex('skipé中tail', 4, 5)).toBe(6)
  })

  it.each([0, -1])('consumes one code point when the %s-byte budget is exceeded', (maxBytes) => {
    expect(getUtf8ChunkEndIndex('😀a', 0, maxBytes)).toBe(2)
  })
})
