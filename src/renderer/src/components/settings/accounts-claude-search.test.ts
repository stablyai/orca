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

import { matchesSettingsSearch } from './settings-search'
import {
  getAccountsClaudeSearchEntries,
  getAskClaudeAccountPerProjectSearchKeywords
} from './accounts-claude-search'

describe('getAccountsClaudeSearchEntries ask-per-project entry', () => {
  it('stays visible under the same query that opens the Claude section', () => {
    const toggleEntry = getAccountsClaudeSearchEntries().find(
      (entry) => entry.title === 'Ask which Claude account to use for each project'
    )
    expect(toggleEntry).toBeDefined()

    // Why: "Accounts" matches the sibling "Claude Accounts" entry and used to
    // hide this toggle because its own keywords lacked the plural form.
    expect(matchesSettingsSearch('Accounts', toggleEntry!)).toBe(true)
    expect(matchesSettingsSearch('ask which', toggleEntry!)).toBe(true)
  })

  it('exposes the same keywords to the toggle SearchableSetting', () => {
    expect(getAskClaudeAccountPerProjectSearchKeywords()).toEqual(
      expect.arrayContaining(['accounts', 'ask which', 'per project', 'prompt'])
    )
  })
})
