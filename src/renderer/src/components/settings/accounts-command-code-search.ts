import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsCommandCodeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.commandCode.title', 'Command Code'),
    description: translate(
      'auto.components.settings.accounts.search.commandCode.description',
      'Credits, plan usage windows, and the renewal date for your Command Code CLI sign-in.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.commandCode.kw.commandCode',
        'command code'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.commandCode.kw.credits',
        'credits'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.commandCode.kw.balance',
        'balance'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.commandCode.kw.cmd',
        'cmd'
      )
    ]
  }
])
