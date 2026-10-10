import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserExtensionsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('settings.browser.extensions.title', 'Extensions'),
  description: translate(
    'settings.browser.extensions.description',
    "Chrome extensions installed in Orca's browser from the Chrome Web Store."
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
    ...translateSearchKeyword('settings.browser.extensions.keyword.extension', 'extension'),
    ...translateSearchKeyword('settings.browser.extensions.keyword.chrome', 'chrome'),
    ...translateSearchKeyword('settings.browser.extensions.keyword.password', 'password manager')
  ]
}))
