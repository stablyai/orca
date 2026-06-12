import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAdvancedPaneSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.advanced.search.11eea3da72',
      'HTTP/1.1 Compatibility'
    ),
    description: translate(
      'auto.components.settings.advanced.search.585f56fae0',
      'Use HTTP/1.1 for Electron networking when HTTP/2 fails behind a proxy.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.advanced.search.e04e9db503', 'advanced'),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.2b4d26d11e',
        'networking'
      ),
      ...translateSearchKeyword('auto.components.settings.advanced.search.4d44352eea', 'network'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.48a1c8f534', 'http'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.4b4ae4345a', 'http2'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.a0f71bd909', 'http/2'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.f8ff125ebe', 'http1'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.621233008b', 'http/1.1'),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.65bf6af262',
        'compatibility'
      ),
      ...translateSearchKeyword('auto.components.settings.advanced.search.f98a60af11', 'proxy'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.4383251647', 'vpn'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.79e0947e95', 'support'),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.6576fce4d2',
        'troubleshooting'
      ),
      ...translateSearchKeyword('auto.components.settings.advanced.search.e61ed8ab33', 'updates'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.a7002e1ac4', 'updater')
    ]
  },
  {
    title: translate(
      'auto.components.settings.advanced.search.385eca8985',
      'Settings Import & Export'
    ),
    description: translate(
      'auto.components.settings.advanced.search.2ec4f12e52',
      'Move portable Orca preferences and shortcuts between machines.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.advanced.search.09e8d65408', 'settings'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.735dca7219', 'transfer'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.e372d43640', 'export'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.8eb749fc33', 'import'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.ad20e91a14', 'portable'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.d22c801503', 'backup'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.568b19b6d0', 'shortcuts'),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.68806106b6',
        'keybindings'
      )
    ]
  }
])

function findEntry(title: string): SettingsSearchEntry {
  const entry = getAdvancedPaneSearchEntries().find((e) => e.title === title)
  if (!entry) {
    throw new Error(`Missing advanced-pane search entry: "${title}"`)
  }
  return entry
}

export function getAdvancedSearchEntry() {
  return {
    http1Compatibility: findEntry(
      translate('auto.components.settings.advanced.search.11eea3da72', 'HTTP/1.1 Compatibility')
    ),
    settingsPortability: findEntry(
      translate('auto.components.settings.advanced.search.385eca8985', 'Settings Import & Export')
    )
  } as const
}
