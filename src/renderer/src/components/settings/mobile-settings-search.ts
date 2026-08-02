import type { SettingsSearchEntry } from './settings-search'
import { getMobilePaneSearchEntries } from './mobile-pane-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getMobileOverviewSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.mobile.settings.search.ffd52a96e4', 'Mobile'),
    description: translate(
      'auto.components.settings.mobile.settings.search.671eb4173c',
      'Control terminals and agents from your phone.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.f213400800',
        'mobile'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.f4ed142753',
        'phone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.5d5af8e041',
        'iphone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.cf2c93b479',
        'pair'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.settings.search.87816d1c59', 'qr'),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.59b1d75fd1',
        'code'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.0b7e585cb9',
        'scan'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.7e801801ac',
        'remote'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.e4f4daea0e',
        'relay'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.a7eececc1d',
        'android'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.6bfa001752',
        'apk'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.8d4ba0ef09',
        'beta'
      ),
      ...translateSearchKeyword('auto.components.settings.mobile.settings.search.b730ff7049', 'app')
    ]
  })
)

export const getMobileSidebarShortcutSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.mobile.settings.search.1de96ec8a6',
      'Show Orca Mobile Button'
    ),
    description: translate(
      'auto.components.settings.mobile.settings.search.682293cadf',
      'Show the Orca Mobile button at the top of the left sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.74618577c7',
        'mobile'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.5e5b8878bf',
        'phone'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.5bff6a2ef0',
        'sidebar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.6cf5f54ce1',
        'button'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.648eeada79',
        'hide'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.mobile.settings.search.ac79fe4a04',
        'show'
      )
    ]
  })
)

export const getMobileSettingsPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    getMobileOverviewSearchEntry(),
    getMobileSidebarShortcutSearchEntry(),
    ...getMobilePaneSearchEntries()
  ]
)
