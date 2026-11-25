import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserUserAgentSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('settings.browser.userAgent.title', 'Browser identity'),
  description: getBrowserUserAgentDescription(translate),
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

export function getBrowserUserAgentDescription(t: Translate): string {
  return t(
    'settings.browser.userAgent.descriptionPageKinds',
    'Choose the user agent for every page this computer shows, including SSH pages and remote pages set to This device. Changes take effect after a restart.'
  )
}
