import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getWslHostsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('auto.components.settings.wslHostsExperimental.title', 'WSL distros as hosts'),
  description: translate(
    'auto.components.settings.wslHosts.settingDescription',
    'Orca runs its server inside each WSL 2 distro you add, so git, files and terminals there run natively in Linux. Turn off to stop adding hosts and moving projects; saved hosts keep serving their projects.'
  ),
  keywords: [
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
}))

/** Indexed only on Windows desktops whose preload exposes WSL hosts. */
export function getWslHostsSearchEntries(): SettingsSearchEntry[] {
  return typeof window !== 'undefined' && window.api?.runtimeEnvironments?.wslHosts
    ? [getWslHostsSearchEntry()]
    : []
}
