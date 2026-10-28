import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SEARCH_QUERY_MAX_BYTES,
  getSettingsSectionSearchEntries,
  isSettingsSearchQueryTooLarge,
  matchesSettingsSearch,
  rankSettingsSearchItems,
  scoreSettingsSearch,
  type SettingsSearchEntry
} from './settings-search'

describe('settings-search', () => {
  it('scores pane title matches above entry, description, and keyword matches', () => {
    const paneTitleMatch = [{ title: 'Keyboard Shortcuts' }]
    const entryTitleMatch = [{ title: 'Interface' }, { title: 'Shortcuts' }]
    const descriptionMatch = [{ title: 'Interface', description: 'Shortcuts' }]
    const keywordMatch = [{ title: 'Interface', keywords: ['shortcuts'] }]

    expect(scoreSettingsSearch('shortcuts', paneTitleMatch)).toBeGreaterThan(
      scoreSettingsSearch('shortcuts', entryTitleMatch)
    )
    expect(scoreSettingsSearch('shortcuts', entryTitleMatch)).toBeGreaterThan(
      scoreSettingsSearch('shortcuts', descriptionMatch)
    )
    expect(scoreSettingsSearch('shortcuts', descriptionMatch)).toBeGreaterThan(
      scoreSettingsSearch('shortcuts', keywordMatch)
    )
  })

  it('includes pane title entries for SettingsSection content filtering', () => {
    const section = {
      title: 'AI Provider Accounts',
      description: 'Optional account switching.',
      searchEntries: [{ title: 'Claude', description: 'Use the signed-in Claude account.' }]
    }

    const entries = getSettingsSectionSearchEntries(section)

    expect(matchesSettingsSearch('accounts', entries)).toBe(true)
    expect(matchesSettingsSearch('accounts', section.searchEntries)).toBe(false)
  })

  it('matches Turkish dotted capital I labels from lowercase queries', () => {
    expect(matchesSettingsSearch('imleç opaklığı', [{ title: 'İmleç Opaklığı' }])).toBe(true)
    expect(matchesSettingsSearch('İMLEÇ', [{ title: 'imleç' }])).toBe(true)
  })

  it('keeps empty search ranking in source order without reading entries', () => {
    const sections = [
      {
        id: 'general',
        get entries(): SettingsSearchEntry[] {
          throw new Error('empty settings searches must not scan entries')
        }
      },
      {
        id: 'shortcuts',
        get entries(): SettingsSearchEntry[] {
          throw new Error('empty settings searches must not scan entries')
        }
      }
    ]

    expect(
      rankSettingsSearchItems('  ', sections, (section) => section.entries).map(
        (section) => section.item.id
      )
    ).toEqual(['general', 'shortcuts'])
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
    expect(scoreSettingsSearch(oversizedQuery, entry)).toBe(0)
    expect(rankSettingsSearchItems(oversizedQuery, [entry], (item) => item)).toEqual([])
  })

  it('rejects oversized whitespace before trimming settings searches', () => {
    expect(
      matchesSettingsSearch(' '.repeat(SETTINGS_SEARCH_QUERY_MAX_BYTES + 1), { title: 'General' })
    ).toBe(false)
  })
})
