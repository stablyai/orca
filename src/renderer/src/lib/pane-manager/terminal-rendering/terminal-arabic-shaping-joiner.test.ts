import { describe, expect, it } from 'vitest'

import { findRtlJoinRanges } from './terminal-arabic-shaping-joiner'

describe('findRtlJoinRanges', () => {
  it('does not open a run at orphan combining marks after an LTR base', () => {
    // Combining marks share their base cell; starting a run there yields an empty joined range that blanks the next WebGL glyph.
    expect(findRtlJoinRanges('a\u064b\u0651b')).toEqual([])
    expect(findRtlJoinRanges('x\u05b0\u05b1y')).toEqual([])
  })

  it('does not open a run at zero-width Cf controls after an LTR base', () => {
    // BOM/ZWNBSP and Arabic number signs have width zero; opening there also creates an empty joined range that blanks the next glyph.
    const BOM = '\ufeff'
    expect(findRtlJoinRanges(`a${BOM}${BOM}b`)).toEqual([])
    expect(findRtlJoinRanges('x\u0600\u0602y')).toEqual([])
    expect(findRtlJoinRanges(`a${BOM}\u0651b`)).toEqual([])
  })
})
