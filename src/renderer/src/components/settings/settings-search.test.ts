import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SEARCH_QUERY_MAX_BYTES,
  isSettingsSearchQueryTooLarge,
  matchesSettingsSearch,
  normalizeSettingsSearchQuery,
  type SettingsSearchEntry
} from './settings-search'

describe('settings-search', () => {
  it('normalizes settings search text for callers that need local query state', () => {
    expect(normalizeSettingsSearchQuery('  Terminal Rendering  ')).toBe('terminal rendering')
  })

  it('matches titles, descriptions, and keywords case-insensitively', () => {
    const entry = {
      title: 'Terminal',
      description: 'Rendering settings',
      keywords: ['shell', 'conpty']
    }

    expect(matchesSettingsSearch('render', entry)).toBe(true)
    expect(matchesSettingsSearch('CONPTY', entry)).toBe(true)
    expect(matchesSettingsSearch('voice', entry)).toBe(false)
  })

  it('treats empty search as matching all entries', () => {
    expect(matchesSettingsSearch('   ', { title: 'General' })).toBe(true)
  })

  it('rejects oversized pasted searches before reading settings entries', () => {
    const oversizedQuery = 'secret-settings-search'.repeat(SETTINGS_SEARCH_QUERY_MAX_BYTES)
    const entry = {
      get title(): string {
        throw new Error('oversized settings searches must not scan titles')
      },
      get description(): string {
        throw new Error('oversized settings searches must not scan descriptions')
      },
      get keywords(): string[] {
        throw new Error('oversized settings searches must not scan keywords')
      }
    } as SettingsSearchEntry

    expect(isSettingsSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(matchesSettingsSearch(oversizedQuery, entry)).toBe(false)
  })

  it('rejects oversized whitespace before trimming settings searches', () => {
    expect(
      matchesSettingsSearch(' '.repeat(SETTINGS_SEARCH_QUERY_MAX_BYTES + 1), { title: 'General' })
    ).toBe(false)
  })
})
