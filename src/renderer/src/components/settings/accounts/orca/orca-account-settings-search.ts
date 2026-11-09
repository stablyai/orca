import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export const getOrcaAccountSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.orcaAccount.account', 'Orca account'),
    description: translate(
      'auto.components.settings.orcaAccount.searchDescription',
      'Sign in or out of the account used by Artifacts and Orca Relay.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordAccount', 'account'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordLogin', 'login'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordLogout', 'logout'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordSignIn', 'sign in'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordSignOut', 'sign out'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordRelay', 'relay'),
      ...translateSearchKeyword('auto.components.settings.orcaAccount.keywordCloud', 'cloud')
    ]
  },
  {
    title: translate('cloudSecrets.title', 'Cloud secrets'),
    description: translate(
      'cloudSecrets.searchDescription',
      'Environment variables and agent keys for Orca Cloud workspaces: personal, shared with your team, or per repository.'
    ),
    keywords: [
      ...translateSearchKeyword('cloudSecrets.keywordSecret', 'secret'),
      ...translateSearchKeyword('cloudSecrets.keywordEnv', 'environment variable'),
      ...translateSearchKeyword('cloudSecrets.keywordDotenv', '.env'),
      ...translateSearchKeyword('cloudSecrets.keywordApiKey', 'api key'),
      ...translateSearchKeyword('cloudSecrets.keywordGateway', 'ai gateway')
    ]
  }
])
