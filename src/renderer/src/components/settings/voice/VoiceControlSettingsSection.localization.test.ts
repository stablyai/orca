import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'

const englishLabels: Record<string, string> =
  en.auto.components.settings.VoiceControlSettingsSection
const translatedLabels = { es, fr, ja, ko, zh }

describe('VoiceControlSettingsSection localization', () => {
  it('uses generated localization keys', () => {
    expect(Object.keys(englishLabels).every((key) => /^[a-f0-9]{10}$/.test(key))).toBe(true)
  })

  it.each(Object.entries(translatedLabels))('translates every label in %s', (_locale, catalog) => {
    const labels: Record<string, string> =
      catalog.auto.components.settings.VoiceControlSettingsSection

    for (const [key, englishLabel] of Object.entries(englishLabels)) {
      expect(labels[key]).toBeTruthy()
      expect(labels[key]).not.toBe(englishLabel)
    }
  })
})
