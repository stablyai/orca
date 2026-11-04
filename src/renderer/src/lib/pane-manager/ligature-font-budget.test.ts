import { describe, expect, it } from 'vitest'
import { isLigatureFontWithinBudget } from './ligature-font-budget'

/** sfnt with one calt chained-context (6.3) rule whose backtrack, input and lookahead share one coverage. */
function buildChainedContextFont(glyphsPerPosition: number): ArrayBuffer {
  const gsubOffset = 28
  const coverageOffset = gsubOffset + 52
  const view = new DataView(new ArrayBuffer(coverageOffset + 4 + glyphsPerPosition * 2))
  const u16 = (offset: number, value: number): void => view.setUint16(offset, value)
  const u32 = (offset: number, value: number): void => view.setUint32(offset, value)
  u32(0, 0x00010000)
  u16(4, 1)
  u32(12, 0x47535542) // GSUB
  u32(20, gsubOffset)
  u32(24, view.byteLength - gsubOffset)
  u16(gsubOffset, 1)
  u16(gsubOffset + 6, 10) // FeatureList
  u16(gsubOffset + 8, 24) // LookupList
  u16(gsubOffset + 10, 1)
  u32(gsubOffset + 12, 0x63616c74) // calt
  u16(gsubOffset + 16, 8)
  u16(gsubOffset + 20, 1)
  u16(gsubOffset + 22, 0)
  u16(gsubOffset + 24, 1)
  u16(gsubOffset + 26, 4)
  u16(gsubOffset + 28, 6) // chained context lookup
  u16(gsubOffset + 32, 1)
  u16(gsubOffset + 34, 8)
  const subtable = gsubOffset + 36
  u16(subtable, 3)
  for (const countOffset of [2, 6, 10]) {
    u16(subtable + countOffset, 1)
    u16(subtable + countOffset + 2, coverageOffset - subtable)
  }
  u16(coverageOffset, 1)
  u16(coverageOffset + 2, glyphsPerPosition)
  for (let glyph = 0; glyph < glyphsPerPosition; glyph++) {
    u16(coverageOffset + 4 + glyph * 2, glyph + 1)
  }
  return view.buffer
}

describe('isLigatureFontWithinBudget', () => {
  it('rejects fonts whose calt contexts would expand into millions of glyph sequences', () => {
    // 200 x 200 x 200 contexts, like Commit Mono's letter-spacing rules.
    expect(isLigatureFontWithinBudget(buildChainedContextFont(200))).toBe(false)
  })

  it('accepts fonts with ordinary ligature rules', () => {
    expect(isLigatureFontWithinBudget(buildChainedContextFont(20))).toBe(true)
  })
})
