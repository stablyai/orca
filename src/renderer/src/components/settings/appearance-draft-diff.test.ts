import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  areAppearanceSettingValuesEqual,
  getAppearanceDraftChangedKeys,
  getAppearanceDraftChanges
} from './appearance-draft-diff'

function asSettings(values: Partial<GlobalSettings>): GlobalSettings {
  return values as GlobalSettings
}

describe('appearance draft diff', () => {
  it('compares primitive, null, and undefined values', () => {
    expect(areAppearanceSettingValuesEqual('dark', 'dark')).toBe(true)
    expect(areAppearanceSettingValuesEqual(true, false)).toBe(false)
    expect(areAppearanceSettingValuesEqual(14, 15)).toBe(false)
    expect(areAppearanceSettingValuesEqual(null, null)).toBe(true)
    expect(areAppearanceSettingValuesEqual(null, undefined)).toBe(false)
    expect(areAppearanceSettingValuesEqual(undefined, undefined)).toBe(true)
  })

  it('compares nested records independent of key order and arrays by value', () => {
    const current = {
      palette: { foreground: '#fff', background: '#000' },
      variants: [{ name: 'dim', colors: ['gray', 'black'] }]
    }
    const reordered = {
      variants: [{ colors: ['gray', 'black'], name: 'dim' }],
      palette: { background: '#000', foreground: '#fff' }
    }

    expect(areAppearanceSettingValuesEqual(current, reordered)).toBe(true)
    expect(
      areAppearanceSettingValuesEqual(current, {
        ...reordered,
        variants: [{ colors: ['black', 'gray'], name: 'dim' }]
      })
    ).toBe(false)
  })

  it('keeps an explicit undefined reset in the changes', () => {
    const settings = asSettings({ leftSidebarTintColor: '#336699' })
    const changes = getAppearanceDraftChanges(settings, { leftSidebarTintColor: undefined })

    expect(changes).toEqual({ leftSidebarTintColor: undefined })
    expect(Object.hasOwn(changes, 'leftSidebarTintColor')).toBe(true)
  })

  it('returns only changed draft values and typed changed keys', () => {
    const settings = asSettings({
      theme: 'dark',
      terminalFontSize: 14,
      terminalColorOverrides: { foreground: '#fff' }
    })
    const draft: Partial<GlobalSettings> = {
      theme: 'dark',
      terminalFontSize: 16,
      terminalColorOverrides: { foreground: '#fff' }
    }
    const changedKeys: (keyof GlobalSettings)[] = getAppearanceDraftChangedKeys(settings, draft)

    expect(changedKeys).toEqual(['terminalFontSize'])
    expect(getAppearanceDraftChanges(settings, draft)).toEqual({ terminalFontSize: 16 })
  })
})
