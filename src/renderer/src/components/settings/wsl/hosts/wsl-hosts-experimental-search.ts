import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getWslHostsExperimentalSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.wslHostsExperimental.title', 'WSL distros as hosts'),
    description: translate(
      'auto.components.settings.wslHostsExperimental.description',
      'Run Orca’s server inside a WSL 2 distro, so git, files and terminals run natively in Linux.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword('auto.components.settings.wslHostsExperimental.keywordWsl', 'wsl'),
      ...translateSearchKeyword(
        'auto.components.settings.wslHostsExperimental.keywordLinux',
        'linux'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.wslHostsExperimental.keywordDistro',
        'distro'
      )
    ],
    targetSectionId: 'wsl-hosts'
  })
)
