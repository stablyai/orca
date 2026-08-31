import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'

const englishLabels = en.auto.components.dictation.DictationIndicator as Record<string, string>
const translatedLabels = { es, ja, ko, zh }

describe('DictationIndicator localization', () => {
  it('uses generated localization keys', () => {
    expect(Object.keys(englishLabels).every((key) => /^[a-f0-9]{10}$/.test(key))).toBe(true)
  })

  it.each(Object.entries(translatedLabels))('translates every label in %s', (_locale, catalog) => {
    const labels = catalog.auto.components.dictation.DictationIndicator as Record<string, string>

    for (const [key, englishLabel] of Object.entries(englishLabels)) {
      expect(labels[key]).toBeTruthy()
      expect(labels[key]).not.toBe(englishLabel)
    }
  })
})
