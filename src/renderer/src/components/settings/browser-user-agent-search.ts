import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserUserAgentSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('settings.browser.userAgent.title', 'Browser identity'),
  description: translate(
    'settings.browser.userAgent.description',
    'Choose the user agent for every browser profile and page. Native mode disables Google sign-in. Changes take effect after a restart.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.userAgent.identity',
      'identity'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.userAgent.userAgent',
      'user agent'
    ),
    ...translateSearchKeyword('auto.components.settings.browser.search.userAgent.native', 'native'),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.userAgent.cleaned',
      'cleaned'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.userAgent.restart',
      'restart'
    )
  ]
}))
