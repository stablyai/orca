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

export const getMobileSettingsPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [getMobileOverviewSearchEntry(), ...getMobilePaneSearchEntries()]
)
