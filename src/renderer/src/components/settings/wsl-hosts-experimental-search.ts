import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getWslHostsExperimentalSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.wslHostsExperimental.title', 'WSL distros as hosts'),
    description: translate(
      'auto.components.settings.wslHostsExperimental.description',
      'Add a WSL 2 distro as a host. Orca runs its server inside the distro, so git, files and terminals in new projects there run natively in Linux.'
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
