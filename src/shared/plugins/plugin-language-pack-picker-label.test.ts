import { describe, expect, it } from 'vitest'
import { pluginLanguagePackPickerLabel } from './plugin-language-pack-picker-label'

describe('pluginLanguagePackPickerLabel', () => {
  it('prefers a declared native displayName', () => {
    expect(
      pluginLanguagePackPickerLabel({
        locale: 'zh-TW',
        pluginKey: 'farrrr.i18n-zh-tw',
        displayName: '中文（繁體）'
      })
    ).toBe('中文（繁體）')
  })

  it('falls back to locale — pluginKey when displayName is absent', () => {
    expect(
      pluginLanguagePackPickerLabel({
        locale: 'zh-TW',
        pluginKey: 'farrrr.i18n-zh-tw'
      })
    ).toBe('zh-TW — farrrr.i18n-zh-tw')
  })
})
