import { describe, expect, it } from 'vitest'
import {
  resolveAppearanceAccordionDeepLink,
  USAGE_PERCENTAGE_DISPLAY_SETTING_ID
} from './appearance-usage-percentage-search'

describe('resolveAppearanceAccordionDeepLink', () => {
  it('maps the usage percentage row to the Window accordion', () => {
    expect(resolveAppearanceAccordionDeepLink(USAGE_PERCENTAGE_DISPLAY_SETTING_ID)).toBe('window')
  })

  it('returns null for unknown or missing section ids', () => {
    expect(resolveAppearanceAccordionDeepLink(undefined)).toBeNull()
    expect(resolveAppearanceAccordionDeepLink('something-else')).toBeNull()
  })
})
