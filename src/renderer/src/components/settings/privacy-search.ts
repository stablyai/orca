// Settings-search entries for the Privacy pane. Kept in its own file to
// mirror the other per-pane search modules (notifications-search.ts,
// terminal-search.ts, etc.) and keep Settings.tsx imports uniform.

import type { SettingsSearchEntry } from './settings-search'

export const PRIVACY_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Privacy & Telemetry',
    description: 'Anonymous product usage data and telemetry controls.',
    keywords: [
      'privacy',
      'telemetry',
      'analytics',
      'usage',
      'anonymous',
      'data',
      'posthog',
      'opt out',
      'opt in'
    ]
  },
  {
    title: 'Share Anonymous Usage Data',
    description: 'Help improve Orca by sending anonymous feature-usage events.',
    keywords: ['telemetry', 'usage', 'anonymous', 'opt in', 'opt out', 'share']
  },
  {
    title: 'Telemetry environment variables',
    description: 'Environment variables that disable telemetry transmission.',
    keywords: [
      'do not track',
      'do_not_track',
      'orca_telemetry_disabled',
      'ci',
      'continuous integration',
      'env',
      'environment variable',
      'disable'
    ]
  }
]
