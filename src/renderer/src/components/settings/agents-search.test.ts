import { describe, expect, it } from 'vitest'
import { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search'

describe('AGENTS_PANE_SEARCH_ENTRIES', () => {
  it('indexes custom instruction settings', () => {
    const haystack = JSON.stringify(AGENTS_PANE_SEARCH_ENTRIES).toLowerCase()

    expect(haystack).toContain('custom instructions')
    expect(haystack).toContain('personalization')
    expect(haystack).toContain('system prompt')
  })
})
