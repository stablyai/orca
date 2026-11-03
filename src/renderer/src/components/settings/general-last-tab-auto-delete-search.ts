import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getLastTabAutoDeleteSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.general.last.tab.auto.delete.search.3684b9708d',
      'Delete Workspace When Its Last Tab Closes'
    ),
    description: translate(
      'auto.components.settings.general.last.tab.auto.delete.search.b3c70b70de',
      'Run the normal workspace delete when closing a tab leaves its workspace empty.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('auto.components.settings.general.search.7baf524b04', 'workspace'),
      ...translateSearchKeyword(
        'auto.components.settings.general.last.tab.auto.delete.search.de1a617f26',
        'last tab'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.afa37a34e1', 'close'),
      ...translateSearchKeyword(
        'auto.components.settings.general.last.tab.auto.delete.search.d1510d050c',
        'exit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.general.last.tab.auto.delete.search.a798135810',
        'auto'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.general.last.tab.auto.delete.search.ad36681f93',
        'remove'
      )
    ]
  }
])
