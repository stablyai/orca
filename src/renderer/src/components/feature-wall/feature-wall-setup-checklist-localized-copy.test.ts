import { describe, expect, it } from 'vitest'

import { FEATURE_WALL_SETUP_STEPS } from '../../../../shared/feature-wall-setup-steps'
import { getLocalizedFeatureWallSetupChecklistCopy } from './feature-wall-setup-checklist-localized-copy'

import { i18n } from '../../i18n/i18n'

describe('feature-wall-setup-checklist-localized-copy', () => {
  it.each(['ja', 'ko'])(
    'resolves every checklist step through the %s runtime catalog',
    async (locale) => {
      try {
        await i18n.changeLanguage(locale)
        for (const step of FEATURE_WALL_SETUP_STEPS) {
          const localized = getLocalizedFeatureWallSetupChecklistCopy(step)
          expect(localized.name, step.id).not.toBe(step.name)
          expect(localized.description, step.id).not.toBe(step.description)
        }
      } finally {
        await i18n.changeLanguage('en')
      }
    }
  )
})
