import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getDockerPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.docker.search.633b31f94b',
      'Docker Connections'
    ),
    description: translate(
      'auto.components.settings.docker.search.2230311be7',
      'Manage Docker daemons.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.docker.search.f38f8eaa79', 'docker'),
      ...translateSearchKeyword('auto.components.settings.docker.search.6ceaa333f3', 'connection'),
      ...translateSearchKeyword('auto.components.settings.docker.search.3af4b2d56a', 'host'),
      ...translateSearchKeyword('auto.components.settings.docker.search.0480c72459', 'daemon'),
      ...translateSearchKeyword('auto.components.settings.docker.search.fa55eeb341', 'local'),
      ...translateSearchKeyword('auto.components.settings.docker.search.1308d6c3e7', 'tcp')
    ]
  }
])
