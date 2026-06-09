import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getRuntimeEnvironmentsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.runtime.environments.search.3517fb2ec0',
      'Active Server'
    ),
    description: translate(
      'auto.components.settings.runtime.environments.search.4575341c77',
      'Choose local desktop, add a saved remote Orca server, or generate a pairing URL.'
    ),
    keywords: [
      translate('auto.components.settings.runtime.environments.search.d198440ce3', 'runtime'),
      translate('auto.components.settings.runtime.environments.search.ebd5369acf', 'environment'),
      translate('auto.components.settings.runtime.environments.search.09568ccc65', 'server'),
      translate('auto.components.settings.runtime.environments.search.d760866285', 'client'),
      translate('auto.components.settings.runtime.environments.search.5cd7dca3b8', 'remote'),
      translate('auto.components.settings.runtime.environments.search.104f4d7dbd', 'pairing'),
      translate('auto.components.settings.runtime.environments.search.81444c4102', 'pairing url'),
      translate('auto.components.settings.runtime.environments.search.f1575f1e09', 'web client'),
      translate('auto.components.settings.runtime.environments.search.45501ff2c3', 'cloud'),
      translate('auto.components.settings.runtime.environments.search.772e3b4753', 'vm'),
      translate('auto.components.settings.runtime.environments.search.c6e5a03aa0', 'dev box')
    ]
  })
)

export const getWebRuntimeEnvironmentsSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.runtime.environments.search.3517fb2ec0',
      'Active Server'
    ),
    description: translate(
      'auto.components.settings.runtime.environments.search.baec27aa8f',
      'Connect this browser to a saved Orca server.'
    ),
    keywords: [
      translate('auto.components.settings.runtime.environments.search.d198440ce3', 'runtime'),
      translate('auto.components.settings.runtime.environments.search.ebd5369acf', 'environment'),
      translate('auto.components.settings.runtime.environments.search.09568ccc65', 'server'),
      translate('auto.components.settings.runtime.environments.search.d760866285', 'client'),
      translate('auto.components.settings.runtime.environments.search.5cd7dca3b8', 'remote'),
      translate('auto.components.settings.runtime.environments.search.2bd988d041', 'pairing code'),
      translate('auto.components.settings.runtime.environments.search.45501ff2c3', 'cloud'),
      translate('auto.components.settings.runtime.environments.search.772e3b4753', 'vm')
    ]
  })
)
