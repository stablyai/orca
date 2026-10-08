import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsLocationSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.d09fb5ca92', 'Account Location'),
    description: translate(
      'auto.components.settings.accounts.search.b84a5b0c8a',
      'Choose whether provider accounts are inspected and added on this device or in WSL.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.06662af91e', 'account'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.593720c17f', 'location'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.bdbd1e668e', 'windows'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.0b4d948eb5', 'wsl'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.488a7e9206', 'linux'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.9f70aa706c', 'provider'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.e02c136ad0', 'auth')
    ]
  }
])
