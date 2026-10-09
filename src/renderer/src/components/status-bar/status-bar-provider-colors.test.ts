import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_COLORS, resolveProviderTint } from './status-bar-provider-colors'

describe('resolveProviderTint', () => {
  it('stays off unless enabled', () => {
    expect(resolveProviderTint(null, 'claude')).toBeUndefined()
    expect(
      resolveProviderTint({ statusBarProviderColors: { claude: '#ff0000' } }, 'claude')
    ).toBeUndefined()
  })

  it('uses the custom color, falling back to the default when blank or missing', () => {
    const settings = {
      statusBarProviderColorsEnabled: true,
      statusBarProviderColors: { claude: ' #ff0000 ', gemini: '  ' }
    }
    expect(resolveProviderTint(settings, 'claude')).toBe(
      'color-mix(in srgb, #ff0000 28%, transparent)'
    )
    expect(resolveProviderTint(settings, 'gemini')).toContain(DEFAULT_PROVIDER_COLORS.gemini)
    expect(resolveProviderTint(settings, 'codex')).toContain(DEFAULT_PROVIDER_COLORS.codex)
  })
})
