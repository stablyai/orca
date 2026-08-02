import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAdvancedNetworkSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.AdvancedNetworkSettingsSection.c46cdbbd4e',
      'Network'
    ),
    description: translate(
      'auto.components.settings.AdvancedNetworkSettingsSection.823e0f15b1',
      'Proxy URL for Orca network requests and local terminal children.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      ...translateSearchKeyword('auto.components.settings.general.search.8f03d44672', 'http_proxy'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.b9096a44cf',
        'https_proxy'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.91a46caafc', 'no_proxy'),
      ...translateSearchKeyword('auto.components.settings.general.search.3a73054565', 'bypass'),
      ...translateSearchKeyword('auto.components.settings.general.search.3566fce83f', 'localhost'),
      ...translateSearchKeyword('auto.components.settings.general.search.c56cb6f1c2', 'network')
    ]
  }
])
