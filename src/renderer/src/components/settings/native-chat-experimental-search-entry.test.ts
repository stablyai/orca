import { describe, expect, it } from 'vitest'
import { getNativeChatExperimentalSearchEntry } from './native-chat-experimental-search-entry'
import { matchesSettingsSearch } from './settings-search'

describe('native chat experimental search entry', () => {
  it.each(['openclaude', 'omp'])('matches the supported-agent keyword %s', (query) => {
    expect(matchesSettingsSearch(query, getNativeChatExperimentalSearchEntry())).toBe(true)
  })

  it('matches "queue" so the Queue follow-ups switch is findable', () => {
    expect(matchesSettingsSearch('queue', getNativeChatExperimentalSearchEntry())).toBe(true)
  })
})
