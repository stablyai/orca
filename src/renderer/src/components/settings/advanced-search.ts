import type { SettingsSearchEntry } from './settings-search'

export const ADVANCED_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'HTTP/1.1 Compatibility',
    description: 'Use HTTP/1.1 for Electron networking when HTTP/2 fails behind a proxy.',
    keywords: [
      'advanced',
      'networking',
      'network',
      'http',
      'http2',
      'http/2',
      'http1',
      'http/1.1',
      'compatibility',
      'proxy',
      'vpn',
      'support',
      'troubleshooting',
      'updates',
      'updater'
    ]
  }
]

function findEntry(title: string): SettingsSearchEntry {
  const entry = ADVANCED_PANE_SEARCH_ENTRIES.find((e) => e.title === title)
  if (!entry) {
    throw new Error(`Missing advanced-pane search entry: "${title}"`)
  }
  return entry
}

export const ADVANCED_SEARCH_ENTRY = {
  http1Compatibility: findEntry('HTTP/1.1 Compatibility')
} as const
