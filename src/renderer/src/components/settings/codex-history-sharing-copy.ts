import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getCodexHistorySharingTitle(): string {
  return translate(
    'settings.agents.codexHistorySharing.title',
    'Share Codex history across accounts'
  )
}

export function getCodexHistorySharingDescription(): string {
  return translate(
    'settings.agents.codexHistorySharing.description',
    "Lets each Codex account, and your own ~/.codex, resume conversations started on the others. Turn off to keep every account's history separate. Turning it off removes nothing already shared."
  )
}

export function getCodexHistorySharingUnsupported(host: string): string {
  return translate(
    'settings.agents.codexHistorySharing.unsupported',
    'Update Orca on {{host}} to change this setting there.',
    { host }
  )
}

export function getCodexHistorySharingUpdateFailed(host: string): string {
  return translate(
    'settings.agents.codexHistorySharing.updateFailed',
    'Could not update the setting on {{host}}.',
    { host }
  )
}

export function getCodexHistorySharingSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.agents.search.5ded38b843',
      fallback: 'codex',
      englishOnly: true
    },
    { key: 'auto.components.settings.terminal.search.3982d88725', fallback: 'history' },
    { key: 'auto.components.settings.privacy.search.ead1deded2', fallback: 'share' },
    { key: 'auto.components.settings.agents.search.9f3becc4e8', fallback: 'shared' },
    { key: 'auto.components.settings.accounts.search.06662af91e', fallback: 'account' }
  ])
}
