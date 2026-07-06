import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

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
