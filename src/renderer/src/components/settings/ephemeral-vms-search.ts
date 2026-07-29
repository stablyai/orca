import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getEphemeralVmsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.ephemeralVms.search.title',
      'Per-Workspace Environments'
    ),
    description: translate(
      'auto.components.settings.ephemeralVms.search.description',
      'Learn how repo-owned recipes give each workspace its own on-demand, disposable environment.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword('auto.components.settings.ephemeralVms.search.keywordVm', 'vm'),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordSandbox',
        'sandbox'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordCloud',
        'cloud'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordRecipe',
        'recipe'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.ephemeralVms.search.keywordEphemeral',
        'ephemeral'
      )
    ],
    targetSectionId: 'ephemeral-vms'
  })
)
