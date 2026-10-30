import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { mergeFontSuggestions } from './SettingsConstants'

describe('mergeFontSuggestions', () => {
  it('keeps installed fonts beyond the old hydration cutoff', () => {
    const systemFonts = Array.from({ length: 350 }, (_value, index) => `System Font ${index}`)
    const suggestions = mergeFontSuggestions(systemFonts, ['JetBrains Mono'])

    expect(suggestions).toContain(DEFAULT_APP_FONT_FAMILY)
    expect(suggestions).toContain('System Font 349')
    expect(suggestions).toContain('JetBrains Mono')
  })
})
