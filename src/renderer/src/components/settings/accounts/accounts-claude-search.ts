import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

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
    title: translate(
      'accounts.claude.switchSessions.settingTitle',
      'When you switch accounts while Claude is running in terminals'
    ),
    description: translate(
      'accounts.claude.switchSessions.settingDescription',
      'Restarting continues each terminal conversation on the new account.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      ...translateSearchKeyword('accounts.claude.switchSessions.keyword.restart', 'restart'),
      ...translateSearchKeyword('accounts.claude.switchSessions.keyword.running', 'running')
    ]
  },
  {
    title: translate(
      'accounts.claude.autoSwitch.settingTitle',
      'Switch accounts automatically when usage runs low'
    ),
    description: translate(
      'accounts.claude.autoSwitch.settingDescription',
      'Selects the Claude account with the most usage left when the selected account drops below a minimum. Running sessions are handled as for a manual switch.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota'),
      ...translateSearchKeyword('accounts.claude.autoSwitch.keyword.automatic', 'automatic'),
      ...translateSearchKeyword('accounts.claude.autoSwitch.keyword.usage', 'usage')
    ]
  }
])
