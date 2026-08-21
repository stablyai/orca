import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getMCodeAccountSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.mcodeAccount.account', 'MCode account'),
    description: translate(
      'auto.components.settings.mcodeAccount.searchDescription',
      'Sign in or out of the account used by Artifacts and MCode Relay.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordAccount', 'account'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordLogin', 'login'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordLogout', 'logout'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordSignIn', 'sign in'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordSignOut', 'sign out'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordRelay', 'relay'),
      ...translateSearchKeyword('auto.components.settings.mcodeAccount.keywordCloud', 'cloud')
    ]
  }
])
