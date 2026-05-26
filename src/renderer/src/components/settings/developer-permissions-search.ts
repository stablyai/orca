import type { SettingsSearchEntry } from './settings-search'

export const DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Developer Permissions',
    description: 'macOS permissions for terminal-launched developer tools.',
    keywords: ['permissions', 'privacy', 'tcc', 'macos', 'developer tools']
  },
  {
    title: 'Microphone and Camera',
    description: 'Allow voice, transcription, webcam, and media capture tools.',
    keywords: ['microphone', 'camera', 'voice', 'audio', 'video', 'sox', 'ffmpeg', 'whisper']
  },
  {
    title: 'Screen Recording and Accessibility',
    description: 'Allow screenshots, screen inspection, keystrokes, and window automation.',
    keywords: ['screen recording', 'accessibility', 'screenshot', 'automation', 'window']
  },
  {
    title: 'Full Disk Access',
    description: 'Open the macOS privacy pane for broad terminal file access.',
    keywords: ['full disk access', 'documents', 'downloads', 'desktop', 'icloud']
  },
  {
    title: 'Local Network, USB, and Bluetooth',
    description: 'Allow device and local-network tools used from terminal sessions.',
    keywords: ['local network', 'usb', 'bluetooth', 'bonjour', 'mdns', 'device']
  }
]
