import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsDeepSeekSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('deepseek.accounts.searchTitle', 'DeepSeek balance'),
    description: translate(
      'deepseek.accounts.searchDescription',
      'Save a protected API key and view prepaid currency balances.'
    ),
    keywords: [
      ...translateSearchKeyword('deepseek.search.name', 'deepseek'),
      ...translateSearchKeyword('deepseek.search.balance', 'balance'),
      ...translateSearchKeyword('deepseek.search.apiKey', 'api key'),
      ...translateSearchKeyword('deepseek.search.credits', 'credits'),
      ...translateSearchKeyword('deepseek.search.currency', 'currency'),
      ...translateSearchKeyword('deepseek.search.account', 'account')
    ]
  }
])
