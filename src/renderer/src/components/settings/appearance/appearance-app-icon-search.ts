import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAppIconEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('auto.components.settings.appearance.search.2b313598c6', 'App Icon'),
    description: translate(
      'auto.components.settings.appearance.search.e80c2af428',
      'Choose the app icon shown in the Dock and window switcher.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.2cfb3420c0',
        'app icon'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.1f2880a9d5', 'orca'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.d18b54ca90', 'dock'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.e5bc35d59e', 'window'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.651f35b2c6',
        'switcher'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.f586abfa35', 'blue'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.468448bba4',
        'watercolor'
      ),
      ...translateSearchKeyword('settings.appearance.appIcon.customKeyword', 'custom'),
      ...translateSearchKeyword('settings.appearance.appIcon.importKeyword', 'import')
    ]
  }
])
