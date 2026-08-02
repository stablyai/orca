import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getGeneralSupportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.36a72f0d9e', 'Star Orca on GitHub'),
    description: translate(
      'auto.components.settings.general.search.e0b8c8bc25',
      'Support the project with a GitHub star via the gh CLI.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.e4fb4516d0', 'star'),
      ...translateSearchKeyword('auto.components.settings.general.search.06ea5a69a6', 'github'),
      ...translateSearchKeyword('auto.components.settings.general.search.b65665703a', 'support'),
      ...translateSearchKeyword('auto.components.settings.general.search.e6b01c8e30', 'feedback'),
      ...translateSearchKeyword('auto.components.settings.general.search.bdfb6dc21b', 'like')
    ]
  }
])
