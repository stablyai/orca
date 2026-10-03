import { describe, expect, it } from 'vitest'
import { normalizeTerminalFontFallbacks } from './terminal-font-fallbacks'

describe('normalizeTerminalFontFallbacks', () => {
  it('trims, filters, and case-insensitively deduplicates font names in order', () => {
    expect(
      normalizeTerminalFontFallbacks([
        ' Microsoft YaHei UI ',
        '',
        42,
        'Noto Sans Arabic',
        'microsoft yahei ui'
      ])
    ).toEqual(['Microsoft YaHei UI', 'Noto Sans Arabic'])
  })

  it('returns an empty list for non-array persisted values', () => {
    expect(normalizeTerminalFontFallbacks('Noto Sans')).toEqual([])
    expect(normalizeTerminalFontFallbacks(null)).toEqual([])
  })

  it('bounds persisted stacks', () => {
    const fonts = Array.from({ length: 40 }, (_, index) => `Font ${index}`)
    expect(normalizeTerminalFontFallbacks(fonts)).toHaveLength(32)
  })
})
