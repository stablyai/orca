import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog:
    <T>(loader: () => T) =>
    () =>
      loader()
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

import {
  getAccountsClinePassSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsPaneSearchEntries
} from './accounts-search'

describe('getAccountsMiniMaxSearchEntries', () => {
  it('returns a single entry that targets the MiniMax session cookie flow', () => {
    const entries = getAccountsMiniMaxSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.title).toBe('MiniMax Usage')
    expect(entry.description).toContain('platform.minimax.io')
    expect(entry.description.toLowerCase()).toContain('cookie')
  })

  it('exposes the keywords that drive the Settings search index', () => {
    const [entry] = getAccountsMiniMaxSearchEntries()
    // Why: the Settings search needs at least one of these tokens to
    // surface the MiniMax section when the user types a related term.
    expect(entry.keywords).toEqual(
      expect.arrayContaining(['minimax', 'cookie', 'session', 'rate limit', 'status bar'])
    )
  })

  it('is included in the rolled-up pane search entries', () => {
    const allEntries = getAccountsPaneSearchEntries()
    const titles = allEntries.map((entry) => entry.title)
    expect(titles).toContain('MiniMax Usage')
  })
})

describe('getAccountsClinePassSearchEntries', () => {
  it('indexes ClinePass subscription quota and API-key configuration', () => {
    const entries = getAccountsClinePassSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries

    expect(entry.title).toBe('ClinePass Subscription Quota')
    expect(entry.description).toContain('5-hour, weekly, and monthly')
    expect(entry.keywords).toEqual(
      expect.arrayContaining([
        'clinepass',
        'cline',
        'subscription',
        'quota',
        'api key',
        'CLINE_API_KEY',
        '5-hour',
        'weekly',
        'monthly',
        'rate limit',
        'status bar'
      ])
    )
  })

  it('includes ClinePass in the rolled-up pane search entries', () => {
    expect(getAccountsPaneSearchEntries().map((entry) => entry.title)).toContain(
      'ClinePass Subscription Quota'
    )
  })
})
