import { describe, expect, it } from 'vitest'
import { FEATURE_WALL_SETUP_STEPS } from '../../../../shared/feature-wall-setup-steps'
import { getLocalizedFeatureWallSetupChecklistCopy } from './feature-wall-setup-checklist-localized-copy'
import ko from '../../i18n/locales/ko.json'
import en from '../../i18n/locales/en.json'

describe('feature-wall-setup-checklist-localized-copy', () => {
  it('returns non-empty localized name and description for all setup checklist steps', () => {
    for (const step of FEATURE_WALL_SETUP_STEPS) {
      const localized = getLocalizedFeatureWallSetupChecklistCopy(step)
      expect(localized.name).toBeTruthy()
      expect(localized.description).toBeTruthy()
    }
  })

  it('has valid Korean and English catalog entries for all setup checklist steps', () => {
    const enKeys = en.auto.components.feature.wall.feature.wall.setup.checklist.localized.copy
    const koKeys = ko.auto.components.feature.wall.feature.wall.setup.checklist.localized.copy
    expect(Object.keys(enKeys).length).toBe(16)
    expect(Object.keys(koKeys).length).toBe(16)
    for (const [hash, enVal] of Object.entries(enKeys)) {
      expect(typeof enVal).toBe('string')
      expect((koKeys as Record<string, string>)[hash]).toBeTruthy()
    }
  })
})
