import { describe, expect, it } from 'vitest'
import { buildFontFamily } from './monospace-font-family'

describe('buildFontFamily', () => {
  it('inserts CJK UI fonts ahead of Consolas when wide ambiguous mode is on', () => {
    const result = buildFontFamily('Cascadia Mono', { eastAsianAmbiguousWide: true })
    expect(result).toContain('"Malgun Gothic"')
    expect(result).toContain('"Microsoft YaHei"')
    expect(result.indexOf('"Malgun Gothic"')).toBeLessThan(result.indexOf('"Consolas"'))
    expect(result.indexOf('"Cascadia Mono"')).toBeLessThan(result.indexOf('"Malgun Gothic"'))
  })
})
