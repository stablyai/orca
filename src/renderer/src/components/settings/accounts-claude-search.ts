import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

const getAskClaudeAccountPerProjectSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.AccountsPane.askClaudeAccountPerProjectTitle',
      'Ask which Claude account to use for each project'
    ),
    description: translate(
      'auto.components.settings.AccountsPane.askClaudeAccountPerProjectDescription',
      'When on, projects without a saved Claude account ask before starting Claude.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.06662af91e', 'account'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.askPerProjectAccounts',
        'accounts'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.askPerProjectProject',
        'project'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.askPerProjectPerProject',
        'per project'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.askPerProjectAsk', 'ask'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.askPerProjectAskWhich',
        'ask which'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.askPerProjectPrompt',
        'prompt'
      )
    ]
  })
)

// Why: the toggle's own SearchableSetting needs the identical keyword set so a
// query that opens this pane section also keeps the toggle itself visible.
export function getAskClaudeAccountPerProjectSearchKeywords(): string[] {
  return getAskClaudeAccountPerProjectSearchEntry().keywords ?? []
}

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
  getAskClaudeAccountPerProjectSearchEntry()
])
