import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { getChatBehaviorEntriesByKey } from '../chat/chat-behavior-search'
import { getChatNamingSearchEntry } from '../chat/chat-naming-search'
import { getChatTurnActivityEntriesByKey } from '../chat/chat-turn-activity-search'
import { getFormatOnSaveSearchEntry } from '../editor/EditorFormatOnSaveSetting'
import { getRepositoryFormatterSearchEntry } from '../repository/RepositoryFormatterSection'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

describe('settings search keywords in a localized UI', () => {
  beforeEach(async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each<[string, () => SettingsSearchEntry, string[]]>([
    [
      'mark new messages',
      () => getChatBehaviorEntriesByKey().markNewMessages,
      ['unread', 'no leído']
    ],
    [
      'turn diffs',
      () => getChatTurnActivityEntriesByKey().turnDiffs,
      ['changed files', 'archivos modificados']
    ],
    ['chat names', getChatNamingSearchEntry, ['command template', 'plantilla de comandos']],
    ['format on save', () => getFormatOnSaveSearchEntry(), ['formatter', 'formateador']],
    [
      'formatter command',
      () => getRepositoryFormatterSearchEntry(),
      ['format on save', 'formateador']
    ]
  ])('%s matches English and Spanish keywords', (_name, getEntry, queries) => {
    const entry = getEntry()
    for (const query of queries) {
      expect(matchesSettingsSearch(query, entry), query).toBe(true)
    }
  })
})
