import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

/** Keywords for the machine name, shared by every pane that mounts the field. */
export const getMachineNameSearchKeywords = createLocalizedCatalog(() => [
  ...translateSearchKeyword(
    'auto.components.settings.machine.name.search.machineName',
    'machine name'
  ),
  ...translateSearchKeyword('auto.components.settings.machine.name.search.machine', 'machine'),
  ...translateSearchKeyword('auto.components.settings.machine.name.search.hostname', 'hostname'),
  ...translateSearchKeyword('auto.components.settings.machine.name.search.computer', 'computer'),
  ...translateSearchKeyword('auto.components.settings.machine.name.search.rename', 'rename'),
  ...translateSearchKeyword('auto.components.settings.machine.name.search.name', 'name')
])

export const getMachineNameSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.machine.name.search.title', 'Machine name'),
    description: translate(
      'auto.components.settings.machine.name.search.description',
      'Choose the name other devices and hosts list this computer under.'
    ),
    keywords: getMachineNameSearchKeywords()
  }
])
