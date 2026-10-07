import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getLineageDiscoverySearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate(
        'auto.components.settings.lineageDiscovery.search.title',
        'Fleet / control tower'
      ),
      description: translate(
        'auto.components.settings.lineageDiscovery.search.description',
        'Choose how a control tower workspace finds its related repositories: workspace lineage, a ticket key pattern in names, and manual pull request links.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.fleet',
          'fleet'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.controlTower',
          'control tower'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.lineage',
          'lineage'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.keyPattern',
          'key pattern'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.regex',
          'regex'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.ticket',
          'ticket'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.matchOn',
          'match on'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.lineageDiscovery.search.repositories',
          'repositories'
        )
      ]
    }
  ]
)
