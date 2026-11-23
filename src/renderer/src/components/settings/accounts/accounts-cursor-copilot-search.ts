import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAccountsCursorSearchEntries = createLocalizedCatalog(() => [
  {
    targetSectionId: 'accounts-cursor',
    title: translate('auto.components.settings.accounts.search.cursor.39bbdebe13', 'Cursor usage'),
    description: translate(
      'auto.components.settings.accounts.search.cursor.description',
      'Plan usage read from the Cursor sign-in already on this computer (cursor-agent login).'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.cursor',
        'cursor'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.spend',
        'spend'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.rateLimit',
        'rate limit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.statusBar',
        'status bar'
      )
    ]
  }
])

export const getAccountsCopilotSearchEntries = createLocalizedCatalog(() => [
  {
    targetSectionId: 'accounts-copilot',
    title: translate('auto.components.settings.accounts.search.copilot.title', 'Copilot usage'),
    description: translate(
      'auto.components.settings.accounts.search.copilot.description',
      'AI credit balance read from the Copilot CLI sign-in already on this computer.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.copilot.kw.copilot',
        'copilot'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.copilot.kw.aic', 'aic'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.statusBar',
        'status bar'
      )
    ]
  }
])
