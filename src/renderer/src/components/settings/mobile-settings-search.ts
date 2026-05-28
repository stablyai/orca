import type { SettingsSearchEntry } from './settings-search'
import { MOBILE_PANE_SEARCH_ENTRIES } from './mobile-pane-search'

export const MOBILE_ENABLE_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Mobile',
  description: 'Control terminals and agents from your phone.',
  keywords: [
    'mobile',
    'phone',
    'pair',
    'qr',
    'code',
    'scan',
    'remote',
    'android',
    'apk',
    'beta',
    'experimental'
  ]
}

export const MOBILE_SETTINGS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  MOBILE_ENABLE_SEARCH_ENTRY,
  ...MOBILE_PANE_SEARCH_ENTRIES
]
