import type { SettingsSearchEntry } from './settings-search'

export const SSH_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'SSH Connections',
    description: 'Manage remote SSH targets.',
    keywords: ['ssh', 'remote', 'server', 'connection', 'host']
  },
  {
    title: 'Add SSH Target',
    description: 'Add a new remote SSH target.',
    keywords: ['ssh', 'add', 'new', 'target', 'host', 'server']
  },
  {
    title: 'Import from SSH Config',
    description: 'Import hosts from ~/.ssh/config.',
    keywords: ['ssh', 'import', 'config', 'hosts']
  },
  {
    title: 'Test Connection',
    description: 'Test connectivity to an SSH target.',
    keywords: ['ssh', 'test', 'connection', 'ping']
  }
]
