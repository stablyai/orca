import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'

const COMPONENT = 'AgentSpeakingChips'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveJsonModule types each locale by its own literal keys; the control subtree is homogeneous by construction and this test asserts that.
const control = en.auto.components.voice.control as Record<string, Record<string, string>>
const labels = control[COMPONENT]
const translatedLabels = { es, fr, ja, ko, zh }

describe('agent speaking chips localization', () => {
  it('uses generated localization keys', () => {
    expect(Object.keys(labels).every((key) => /^[a-f0-9]{10}$/.test(key))).toBe(true)
  })

  it.each(Object.entries(translatedLabels))('translates every label in %s', (_locale, catalog) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveJsonModule types each locale by its own literal keys; the control subtree is homogeneous by construction and this test asserts that.
    const localized = catalog.auto.components.voice.control as Record<
      string,
      Record<string, string>
    >
    for (const [key, englishLabel] of Object.entries(labels)) {
      expect(localized[COMPONENT]?.[key]).toBeTruthy()
      expect(localized[COMPONENT]?.[key]).not.toBe(englishLabel)
    }
  })
})
