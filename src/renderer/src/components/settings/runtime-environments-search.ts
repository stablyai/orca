import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getMachineNameSearchKeywords } from './machine-name-search'

export const getRuntimeEnvironmentsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.runtime.environments.search.3517fb2ec0',
      'Remote Orca Servers'
    ),
    description: translate(
      'auto.components.settings.runtime.environments.search.addShareDefault',
      'Add a remote Orca server, share this computer, or choose where new projects open.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.d198440ce3',
        'runtime'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.ebd5369acf',
        'environment'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.09568ccc65',
        'server'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.d760866285',
        'client'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.5cd7dca3b8',
        'remote'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.104f4d7dbd',
        'pairing'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.81444c4102',
        'pairing url'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.f1575f1e09',
        'web client'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.45501ff2c3',
        'cloud'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.772e3b4753',
        'vm'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.c6e5a03aa0',
        'dev box'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.defaultHostKeyword',
        'default host'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.newProjectsKeyword',
        'new projects'
      ),
      // Retain the former setting name for existing users’ searches.
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.activeServerKeyword',
        'active server'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.managedServers.search.title',
        'Orca on your SSH hosts'
      ),
      ...translateSearchKeyword('auto.components.settings.managedServers.search.keywordSsh', 'ssh'),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.shareComputerKeyword',
        'share this computer'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.accessLinkKeyword',
        'access link'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.installKeyword',
        'install server'
      ),
      // Retain the former section name for existing users’ searches.
      ...translateSearchKeyword(
        'auto.components.settings.managedServers.search.keywordFormerName',
        'managed servers'
      ),
      // Index machine-name fields mounted by Share this computer.
      ...getMachineNameSearchKeywords()
    ]
  })
)

export const getWebRuntimeEnvironmentsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.runtime.environments.search.3517fb2ec0',
      'Remote Orca Servers'
    ),
    description: translate(
      'auto.components.settings.runtime.environments.search.baec27aa8f',
      'Connect this browser to a saved Orca server.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.d198440ce3',
        'runtime'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.ebd5369acf',
        'environment'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.09568ccc65',
        'server'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.d760866285',
        'client'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.5cd7dca3b8',
        'remote'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.2bd988d041',
        'pairing code'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.45501ff2c3',
        'cloud'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.runtime.environments.search.772e3b4753',
        'vm'
      )
    ]
  })
)
