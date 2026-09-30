import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getCodexTerminalServerIsolationTitle(): string {
  return translate(
    'settings.agents.codexTerminalServerIsolation.title',
    'Run each Codex terminal on its own server'
  )
}

export function getCodexTerminalServerIsolationDescription(): string {
  return translate(
    'settings.agents.codexTerminalServerIsolation.description',
    "Keeps Orca's status and closing tabs working correctly. Turn off to use Codex's shared server and its agents overview. Applies to new terminals."
  )
}

export function getCodexTerminalServerIsolationSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.agents.search.5ded38b843',
      fallback: 'codex',
      englishOnly: true
    },
    { key: 'auto.components.settings.agents.search.7e15b89f6e', fallback: 'server' },
    { key: 'auto.components.settings.agents.search.ff457e1e7b', fallback: 'daemon' },
    { key: 'auto.components.settings.agents.search.9f3becc4e8', fallback: 'shared' },
    { key: 'auto.components.settings.agents.search.34337ed5c7', fallback: 'isolate' },
    { key: 'auto.components.settings.agents.search.9a84e65118', fallback: 'agents overview' },
    { key: 'auto.components.settings.agents.search.6984d4291a', fallback: 'status' }
  ])
}
