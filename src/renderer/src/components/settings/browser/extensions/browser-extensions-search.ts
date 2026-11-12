import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserExtensionsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('settings.browser.extensions.title', 'Extensions'),
  description: translate(
    'settings.browser.extensions.description',
    'Chrome extensions for the selected local browser profile.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
    ...translateSearchKeyword('settings.browser.extensions.keywordExtension', 'extension'),
    ...translateSearchKeyword('settings.browser.extensions.keywordChrome', 'chrome'),
    ...translateSearchKeyword('settings.browser.extensions.keywordUnpacked', 'unpacked'),
    ...translateSearchKeyword('settings.browser.extensions.keywordPassword', 'password manager')
  ],
  targetSectionId: 'browser-extensions'
}))
