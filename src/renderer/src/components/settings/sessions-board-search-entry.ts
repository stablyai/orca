import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getSessionsBoardSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.sessionsBoard.title',
      'Sessions board'
    ),
    description: translate(
      'auto.components.settings.experimental.search.sessionsBoard.description',
      'Board of every agent session on this machine, grouped into a column per agent type.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.sessions',
        'sessions'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.history',
        'history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.board',
        'board'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.agent',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.transcript',
        'transcript'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.sessionsBoard.vault',
        'vault'
      )
    ]
  }
}
