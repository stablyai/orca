import { describe, expect, it } from 'vitest'
import { getChatPaneSearchEntries, getChatSearchEntry } from './chat-search'
import { matchesSettingsSearch } from './settings-search'

describe('Chat UI settings search', () => {
  it.each(['openclaude', 'omp'])('matches the supported-agent keyword %s', (query) => {
    expect(matchesSettingsSearch(query, getChatSearchEntry('chat-ui'))).toBe(true)
  })

  it('indexes one entry per row, in pane order', () => {
    expect(getChatPaneSearchEntries().map((entry) => entry.id)).toEqual([
      'chat-ui',
      'chat-default-view',
      'chat-resume-on-restart',
      'chat-shell-environment'
    ])
  })

  it('finds the child rows by their own copy', () => {
    const entries = getChatPaneSearchEntries()
    expect(matchesSettingsSearch('default view', entries)).toBe(true)
    expect(matchesSettingsSearch('restart', entries)).toBe(true)
    expect(matchesSettingsSearch('shell environment', entries)).toBe(true)
    expect(matchesSettingsSearch('variables', entries)).toBe(true)
  })

  it('no longer describes Chat UI as experimental', () => {
    expect(matchesSettingsSearch('experimental', getChatPaneSearchEntries())).toBe(false)
    expect(getChatSearchEntry('chat-ui').description).not.toMatch(/preview/i)
  })

  it('drops the host-owned rows for web clients', () => {
    const entries = getChatPaneSearchEntries({ includeHostOwnedRows: false })
    expect(entries.map((entry) => entry.id)).toEqual(['chat-ui', 'chat-default-view'])
    expect(matchesSettingsSearch('restart', entries)).toBe(false)
    expect(matchesSettingsSearch('shell environment', entries)).toBe(false)
  })
})
