import { describe, expect, it } from 'vitest'
import { getNativeChatExperimentalSearchEntry } from './native-chat-experimental-search-entry'
import { matchesSettingsSearch } from './settings-search'

describe('native chat experimental search entry', () => {
  it.each(['openclaude', 'omp'])('matches the supported-agent keyword %s', (query) => {
    expect(matchesSettingsSearch(query, getNativeChatExperimentalSearchEntry())).toBe(true)
  })

  it.each(['inline visuals', 'visuals', 'queue', 'shell environment', 'resume'])(
    'leaves the Chat page settings out of Experimental for %s',
    (query) => {
      expect(matchesSettingsSearch(query, getNativeChatExperimentalSearchEntry())).toBe(false)
    }
  )
})
