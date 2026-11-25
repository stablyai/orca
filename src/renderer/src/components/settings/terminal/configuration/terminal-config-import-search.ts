import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalConfigImportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.a979df0083', 'Import from Ghostty'),
    description: translate(
      'auto.components.settings.terminal.search.73e9422f19',
      'One-time import of supported Ghostty terminal settings.'
    ),
    keywords: [
      // Keep product names searchable without translation.
      'Ghostty',
      'ghostty',
      ...translateSearchKeyword('auto.components.settings.terminal.search.fd752b3cac', 'import'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.2ade3ea490', 'config'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.10f9fb6fea', 'settings')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.kitty_import', 'Import from Kitty'),
    description: translate(
      'auto.components.settings.terminal.search.kitty_import_description',
      'One-time import of supported settings from kitty.conf.'
    ),
    keywords: [
      // Keep product names searchable without translation.
      'Kitty',
      'kitty',
      'kitty.conf',
      ...translateSearchKeyword('auto.components.settings.terminal.search.fd752b3cac', 'import'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.2ade3ea490', 'config')
    ]
  }
])
