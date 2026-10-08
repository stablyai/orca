import { describe, expect, it } from 'vitest'
import {
  chatUiRowsIndexedIn,
  getChatSearchEntry,
  getChatUiSearchEntries,
  type ChatUiRowConditions
} from './chat-search'
import { matchesSettingsSearch } from './settings-search'

const everyRow: ChatUiRowConditions = {
  isWebClient: false,
  structuredChatsInUse: true,
  hostQueuesChatMessages: true
}

function rowIds(conditions: Partial<ChatUiRowConditions>): string[] {
  return getChatUiSearchEntries({ ...everyRow, ...conditions }).map((entry) => entry.id)
}

describe('Chat UI settings search', () => {
  it.each(['claude', 'codex', 'grok', 'omp', 'opencode'])(
    'matches the structured-chat agent keyword %s',
    (query) => {
      expect(matchesSettingsSearch(query, getChatSearchEntry('chat-ui'))).toBe(true)
    }
  )

  it('does not suggest the retired terminal chat parser for openclaude', () => {
    expect(matchesSettingsSearch('openclaude', getChatSearchEntry('chat-ui'))).toBe(false)
  })

  it('indexes one entry per row, in pane order', () => {
    expect(rowIds({})).toEqual([
      'chat-ui',
      'chat-queue-follow-ups',
      'chat-resume-on-restart',
      'chat-shell-environment'
    ])
  })

  it('finds the child rows by their own copy', () => {
    const entries = getChatUiSearchEntries(everyRow)
    expect(matchesSettingsSearch('queue follow-ups', entries)).toBe(true)
    expect(matchesSettingsSearch('restart', entries)).toBe(true)
    expect(matchesSettingsSearch('shell environment', entries)).toBe(true)
    expect(matchesSettingsSearch('variables', entries)).toBe(true)
  })

  it('no longer describes Chat UI as experimental', () => {
    expect(matchesSettingsSearch('experimental', getChatUiSearchEntries(everyRow))).toBe(false)
    expect(getChatSearchEntry('chat-ui').description).not.toMatch(/preview/i)
  })

  it('indexes no Chat UI row for the browser client, which cannot open chats', () => {
    expect(rowIds({ isWebClient: true })).toEqual([])
  })

  it('indexes only the enable switch while no chats are in use on this machine', () => {
    expect(rowIds({ structuredChatsInUse: false })).toEqual(['chat-ui'])
  })

  it('indexes queue follow-ups only when this machine queues follow-ups', () => {
    const entries = getChatUiSearchEntries({ ...everyRow, hostQueuesChatMessages: false })
    expect(entries.map((entry) => entry.id)).toEqual([
      'chat-ui',
      'chat-resume-on-restart',
      'chat-shell-environment'
    ])
    expect(matchesSettingsSearch('queue follow-ups', entries)).toBe(false)
  })

  it('reads back exactly the rows an index lists, ignoring other entries', () => {
    const entries = [
      { title: 'Text size', targetSectionId: 'chat-text-size' },
      ...getChatUiSearchEntries({ ...everyRow, hostQueuesChatMessages: false })
    ]
    expect([...chatUiRowsIndexedIn(entries)]).toEqual([
      'chat-ui',
      'chat-resume-on-restart',
      'chat-shell-environment'
    ])
    expect(chatUiRowsIndexedIn([]).size).toBe(0)
  })
})
