import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getGeneralSidebarSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.GeneralPane.sidebarStyle', 'Sidebar style'),
    description: translate(
      'auto.components.settings.GeneralPane.sidebarStyleDescription',
      'Rail shows icons only.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.sidebar', 'sidebar'),
      ...translateSearchKeyword('auto.components.settings.general.search.railKeyword', 'rail'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.collapseKeyword',
        'collapse'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.compactKeyword',
        'compact'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.iconsKeyword', 'icons')
    ]
  }
])
