import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAccountsAutodetectionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('accounts.autodetection.title', 'Automatically detect existing AI accounts'),
    description: translate(
      'accounts.autodetection.description',
      'Disabling stops automatic usage checks and discovery of unconnected CLI accounts. Explicitly connected accounts and terminal CLI logins are unaffected.'
    ),
    keywords: ['autodetection', 'automatic', 'discovery', 'usage', 'privacy', 'CLI']
  }
])
