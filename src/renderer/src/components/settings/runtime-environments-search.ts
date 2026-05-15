import type { SettingsSearchEntry } from './settings-search'

export const RUNTIME_ENVIRONMENTS_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Active Server',
  description: 'Choose local desktop, add a saved remote Orca server, or generate a pairing URL.',
  keywords: [
    'runtime',
    'environment',
    'server',
    'client',
    'remote',
    'pairing',
    'pairing url',
    'web client',
    'cloud',
    'vm',
    'dev box'
  ]
}

export const WEB_RUNTIME_ENVIRONMENTS_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Active Server',
  description: 'Connect this browser to a saved Orca server.',
  keywords: ['runtime', 'environment', 'server', 'client', 'remote', 'pairing code', 'cloud', 'vm']
}
