import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserProfileScopeSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('settings.browser.profileScope.title', 'Profile for new tabs'),
    description: translate(
      'settings.browser.profileScope.description',
      'Share one Default profile everywhere, or give each repo or workspace its own cookies and storage, so local dev servers stop sharing logins.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.7539f6336c', 'profile'),
      ...translateSearchKeyword('auto.components.settings.browser.search.29193a51d5', 'cookies'),
      ...translateSearchKeyword('auto.components.settings.browser.search.8f036ea11f', 'worktree'),
      ...translateSearchKeyword('settings.browser.profileScope.keywordRepo', 'repo'),
      ...translateSearchKeyword('settings.browser.profileScope.keywordIsolate', 'isolate'),
      ...translateSearchKeyword('auto.components.settings.browser.search.82ba1c80ea', 'localhost')
    ]
  })
)
