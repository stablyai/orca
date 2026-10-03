import { describe, expect, it } from 'vitest'
import { FEATURE_WALL_SETUP_STEPS } from '../../../../shared/feature-wall-setup-steps'
import { getLocalizedFeatureWallSetupChecklistCopy } from './feature-wall-setup-checklist-localized-copy'
import en from '../../i18n/locales/en.json'
import ja from '../../i18n/locales/ja.json'
import ko from '../../i18n/locales/ko.json'

describe('feature-wall-setup-checklist-localized-copy', () => {
  it('returns non-empty localized name and description for all setup checklist steps', () => {
    for (const step of FEATURE_WALL_SETUP_STEPS) {
      const localized = getLocalizedFeatureWallSetupChecklistCopy(step)
      expect(localized.name).toBeTruthy()
      expect(localized.description).toBeTruthy()
    }
  })

  it('has 16 English catalog entries for the setup checklist steps', () => {
    const enKeys = en.auto.components.feature.wall.feature.wall.setup.checklist.localized.copy
    expect(Object.keys(enKeys).length).toBe(16)
    for (const enVal of Object.values(enKeys)) {
      expect(typeof enVal).toBe('string')
    }
  })

  it.each(Object.entries({ ja, ko }))(
    '%s translates every setup checklist step',
    (_locale, catalog) => {
      const enKeys = en.auto.components.feature.wall.feature.wall.setup.checklist.localized.copy
      const localeKeys = catalog.auto.components.feature.wall.feature.wall.setup.checklist.localized
        .copy as Record<string, string>
      expect(Object.keys(localeKeys).length).toBe(16)
      for (const [hash, enVal] of Object.entries(enKeys)) {
        const localeVal = localeKeys[hash]
        expect(typeof localeVal, hash).toBe('string')
        expect(localeVal, hash).toBeTruthy()
        expect(localeVal, hash).not.toBe(enVal)
      }
    }
  )
})
