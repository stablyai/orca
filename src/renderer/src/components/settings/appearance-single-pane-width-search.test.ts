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

import { getSinglePaneWidthEntries } from './appearance-search'

describe('single pane width is reachable from settings search', () => {
  it.each(['width', 'centered', 'max', 'single', 'unsplit', 'wide', 'terminal'])(
    'keeps the keyword %s so an existing search still finds it',
    (keyword) => {
      const keywords = getSinglePaneWidthEntries()[0]?.keywords ?? []
      expect(keywords.some((k) => k.includes(keyword))).toBe(true)
    }
  )

  it('is titled for panes, not terminals', () => {
    expect(getSinglePaneWidthEntries()[0].title).toBe('Single Pane Width')
  })
})
