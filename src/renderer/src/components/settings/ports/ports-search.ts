import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getPortsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.ports.search.title', 'Port Forwarding'),
    description: translate(
      'auto.components.settings.ports.search.descriptionSandboxes',
      'Forward dev servers in sandboxes and on remote hosts to this computer.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.ports.search.ports', 'ports'),
      ...translateSearchKeyword('auto.components.settings.ports.search.forward', 'forward'),
      ...translateSearchKeyword('auto.components.settings.ports.search.localhost', 'localhost'),
      ...translateSearchKeyword('auto.components.settings.ports.search.tunnel', 'tunnel'),
      ...translateSearchKeyword('auto.components.settings.ports.search.devServer', 'dev server')
    ]
  }
])
