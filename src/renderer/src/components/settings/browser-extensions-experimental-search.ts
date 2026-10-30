import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserExtensionsExperimentalSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.experimental.search.browserExtensions.title',
      'Browser extensions'
    ),
    description: translate(
      'auto.components.settings.experimental.search.browserExtensions.description',
      'Run Chrome extensions, such as password managers, in Orca browser tabs.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.browserExtensions.extension',
        'extension'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.browserExtensions.chrome',
        'chrome'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.browserExtensions.password',
        'password manager'
      )
    ],
    targetSectionId: 'experimental-browser-extensions'
  })
)
