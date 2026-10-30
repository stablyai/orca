import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

/** Stable Settings deep-link / scroll target for the Used/Remaining control. */
export const USAGE_PERCENTAGE_DISPLAY_SETTING_ID = 'usage-percentage-display'

/** Appearance section keys that can be force-opened for nested deep links. */
export type AppearanceAccordionSection = 'interface' | 'terminal' | 'window'

/** Resolve the section that must open before a nested deep-link row becomes visible. */
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
