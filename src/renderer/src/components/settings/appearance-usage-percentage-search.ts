import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

/** Stable Settings deep-link / scroll target for the Used/Remaining control. */
export const USAGE_PERCENTAGE_DISPLAY_SETTING_ID = 'usage-percentage-display'

/** Appearance accordion keys that can be force-opened for nested deep links. */
export type AppearanceAccordionSection = 'interface' | 'terminal' | 'window'

/**
 * Map a Settings subsection id to the Appearance accordion that must be open
 * before the row is visible (collapsed accordion content is not user-visible).
 */
export function resolveAppearanceAccordionDeepLink(
  sectionId: string | undefined
): AppearanceAccordionSection | null {
  if (sectionId === USAGE_PERCENTAGE_DISPLAY_SETTING_ID) {
    return 'window'
  }
  return null
}

export const getUsagePercentageDisplayEntry = createLocalizedCatalog(() => ({
  title: translate(
    'auto.components.settings.appearance.search.usagePercentageDisplayTitle',
    'Usage percentages'
  ),
  description: translate(
    'auto.components.settings.appearance.search.usagePercentageDisplayDescription',
    'Choose whether provider limits show the percentage used or remaining.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
    ...translateSearchKeyword('auto.components.settings.appearance.search.896eb53fd4', 'status bar')
  ]
}))
