import { afterEach, describe, expect, it } from 'vitest'
import { pluginFontFamilyWhenLoaded, usePluginFontLoadStore } from './plugin-fonts'

describe('pluginFontFamilyWhenLoaded', () => {
  afterEach(() => usePluginFontLoadStore.setState({ loaded: new Set() }))

  it('leaves out each listed plugin family until it loads', () => {
    expect(pluginFontFamilyWhenLoaded('Menlo (acme.fonts), D2Coding')).toBe('D2Coding')
    expect(pluginFontFamilyWhenLoaded('Menlo (acme.fonts)')).toBe('')
    usePluginFontLoadStore.setState({ loaded: new Set(['menlo (acme.fonts)']) })
    expect(pluginFontFamilyWhenLoaded('D2Coding, Menlo (acme.fonts), Mono (beta.fonts)')).toBe(
      'D2Coding, Menlo (acme.fonts)'
    )
    expect(pluginFontFamilyWhenLoaded('"Menlo (acme.fonts)", D2Coding')).toBe(
      '"Menlo (acme.fonts)", D2Coding'
    )
  })
})
