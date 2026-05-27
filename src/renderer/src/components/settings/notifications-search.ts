import type { SettingsSearchEntry } from './settings-search'

export const NOTIFICATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Notifications',
    description: 'Master switch for Orca desktop notifications.',
    keywords: ['notifications', 'desktop', 'system', 'native']
  },
  {
    title: 'Agent Task Complete',
    description: 'Notify when a coding agent transitions from working to idle.',
    keywords: ['notifications', 'agent', 'complete', 'idle', 'task']
  },
  {
    title: 'Terminal Bell',
    description: 'Notify when a background terminal emits a bell character.',
    keywords: ['notifications', 'terminal', 'bell', 'attention']
  },
  {
    title: 'Suppress While Focused',
    description: 'Avoid notifying when Orca is focused on the active worktree.',
    keywords: ['notifications', 'focused', 'suppress', 'filtering']
  },
  {
    title: 'Notification Sound',
    description:
      'Choose the built-in, system, or local audio file Orca plays for desktop notifications.',
    keywords: [
      'notifications',
      'sound',
      'audio',
      'mp3',
      'wav',
      'ogg',
      'm4a',
      'aac',
      'flac',
      'ding',
      'bong'
    ]
  },
  {
    title: 'Notification Volume',
    description: 'Playback volume for non-system notification sounds.',
    keywords: ['notifications', 'sound', 'volume', 'loudness']
  },
  {
    title: 'Send Test Notification',
    description: 'Trigger a sample desktop notification using the native delivery path.',
    keywords: ['notifications', 'test']
  }
]
