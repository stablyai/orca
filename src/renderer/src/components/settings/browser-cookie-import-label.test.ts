import { beforeEach, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import { i18n, translate } from '@/i18n/i18n'

// Keys for the "From <browser>" import-cookies menu entries. The label is built
// by interpolating the browser name into a single localized string; a regression
// where the name was concatenated directly onto "From" dropped the space and
// rendered e.g. "FromGoogle Chrome".
const IMPORT_FROM_KEYS = [
  'auto.components.settings.BrowserProfileRow.c5a273a809',
  'auto.components.settings.BrowserUsePane.5301857d88'
]
const LAST_IMPORTED_FROM_KEY = 'auto.components.settings.BrowserUsePane.112f70adc4'

function catalogEntry(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (typeof node === 'object' && node !== null) {
      return (node as Record<string, unknown>)[part]
    }
    return undefined
  }, en)
}

describe('import-cookies "From <browser>" label', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('keeps a space between "From" and the browser name', () => {
    for (const key of IMPORT_FROM_KEYS) {
      expect(translate(key, 'From {{value0}}', { value0: 'Google Chrome' })).toBe(
        'From Google Chrome'
      )
      expect(translate(key, 'From {{value0}}', { value0: 'Safari' })).toBe('From Safari')
    }
  })

  it('stores the catalog entry with an interpolation placeholder', () => {
    for (const key of IMPORT_FROM_KEYS) {
      expect(catalogEntry(key)).toBe('From {{value0}}')
    }
    expect(catalogEntry(LAST_IMPORTED_FROM_KEY)).toBe('Last imported from {{value0}}')
  })

  it('keeps a space in the last-imported source label', () => {
    expect(
      translate(LAST_IMPORTED_FROM_KEY, 'Last imported from {{value0}}', {
        value0: 'Google Chrome'
      })
    ).toBe('Last imported from Google Chrome')
  })
})
