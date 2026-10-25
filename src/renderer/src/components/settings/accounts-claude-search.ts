import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsClaudeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.75682e1b62', 'Claude Accounts'),
    description: translate(
      'auto.components.settings.accounts.search.dd75a73991',
      'Optional account switching for Claude while preserving shared chat context.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.06662af91e', 'account'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.8b06729e0f', 'active'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.86edc96bc9',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.f2d666a886', 'optional')
    ]
  },
  {
    title: translate('accounts.claude.autoSwitch', 'Switch accounts before a usage limit'),
    description: translate(
      'accounts.claude.autoSwitchDescription',
      'When the selected account passes 90% of its 5-hour or weekly limit, Orca switches to the account with the most room left, as if you had switched by hand.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.e949b08ffb',
        'rate limit'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword('accounts.claude.keyword.auto', 'auto')
    ]
  },
  {
    title: translate(
      'accounts.claude.switchSessions.settingTitle',
      'When you switch accounts while Claude is running'
    ),
    description: translate(
      'accounts.claude.switchSessions.settingDescription',
      'Restarting continues each running conversation on the new account.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      ...translateSearchKeyword('accounts.claude.switchSessions.keyword.restart', 'restart'),
      ...translateSearchKeyword('accounts.claude.switchSessions.keyword.running', 'running')
    ]
  }
])
