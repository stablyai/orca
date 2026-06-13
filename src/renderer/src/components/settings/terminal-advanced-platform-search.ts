import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalAdvancedSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.7674e758e1', 'Scrollback Size'),
    description: translate(
      'auto.components.settings.terminal.search.f7d56b6281',
      'Maximum terminal scrollback buffer size.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.cde233f5da',
        'scrollback'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fffdff40a7', 'buffer'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.56fff3d113', 'memory')
    ]
  },
  {
    title: translate('auto.components.settings.terminal.search.957a0203fc', 'Word Separators'),
    description: translate(
      'auto.components.settings.terminal.search.3ab64c47d8',
      'Characters treated as word boundaries for double-click selection.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.7286cd2566', 'word'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d4aeafac10', 'separator'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.4ed3e239a8', 'boundary'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.d2a366c7f9',
        'double-click'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.affb14efd4', 'selection')
    ]
  }
])

export const getTerminalMacOptionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.9bd7229927', 'Option as Alt'),
    description: translate(
      'auto.components.settings.terminal.search.1f8b00f5ce',
      "Controls whether the macOS Option key sends Alt/Esc sequences or composes characters. Mirrors Ghostty's macos-option-as-alt."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b37edfc65a', 'option'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.c4427dc5ff', 'alt'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.38f1b4f4cb', 'key'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.7ace5beec9', 'meta'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.983d45cf4c', 'compose'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.1ab57a0fbd', 'mac'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d8d6f7a3c5', 'macos'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.abaa24752d', 'keyboard'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.dd4f6cb541', 'german'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.b3b94cfcb5',
        'international'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fae142a354', 'readline'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.82b63d07fe', 'ghostty')
    ]
  }
])

export const getTerminalMacYenSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.694b8764ac',
      'JIS Yen (¥) to Backslash (\\)'
    ),
    description: translate(
      'auto.components.settings.terminal.search.063914c486',
      'Controls whether pressing the JIS Yen (¥) key sends a backslash (\\) instead.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.9c35f56625', 'yen'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.98059d0944', 'backslash'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.24f7977756', 'japanese'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.abaa24752d', 'keyboard'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.1ab57a0fbd', 'mac'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.d8d6f7a3c5', 'macos'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.b495dc6a9f', 'jis'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.4cec42dbf7', 'intl')
    ]
  }
])

export const getTerminalGhosttyImportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.terminal.search.a979df0083', 'Import from Ghostty'),
    description: translate(
      'auto.components.settings.terminal.search.73e9422f19',
      'One-time import of supported Ghostty terminal settings.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.search.82b63d07fe', 'ghostty'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.fd752b3cac', 'import'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.2ade3ea490', 'config'),
      ...translateSearchKeyword('auto.components.settings.terminal.search.10f9fb6fea', 'settings')
    ]
  }
])
