import type { SettingsSearchEntry } from './settings-search'
import { getAdvancedNetworkSearchEntries } from './advanced-network-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

// Why: mirrors the visible controls — the WSL toggle only renders on Windows, so
// other platforms must not be able to search their way to a hidden control.
export function getAdvancedPaneSearchEntries(platform: {
  isWindows: boolean
}): SettingsSearchEntry[] {
  return [
    ...getAdvancedCompatibilitySearchEntries(),
    ...(platform.isWindows ? getAdvancedWslSessionScanSearchEntries() : [])
  ]
}

const getAdvancedWslSessionScanSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.advanced.search.wslSessionScanTitle',
      'Scan WSL for agent sessions'
    ),
    description: translate(
      'auto.components.settings.advanced.search.wslSessionScanDescription',
      'Include WSL distros in Agent Session History. Off keeps stopped distros from being booted.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.advanced.search.wslKeyword', 'wsl'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.distroKeyword', 'distro'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.vmmemKeyword', 'vmmem'),
      ...translateSearchKeyword('auto.components.settings.advanced.search.memoryKeyword', 'memory'),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.sessionHistoryKeyword',
        'session history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.aiVaultKeyword',
        'ai vault'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.advanced.search.transcriptsKeyword',
        'transcripts'
      )
    ]
  }
])

const getAdvancedCompatibilitySearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  ...getAdvancedNetworkSearchEntries(),
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
  }
])

function findEntry(title: string): SettingsSearchEntry {
  // Why: the superset — the pane itself decides per platform what to render.
  const entry = getAdvancedPaneSearchEntries({ isWindows: true }).find((e) => e.title === title)
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
    wslSessionScan: findEntry(
      translate(
        'auto.components.settings.advanced.search.wslSessionScanTitle',
        'Scan WSL for agent sessions'
      )
    )
  } as const
}
