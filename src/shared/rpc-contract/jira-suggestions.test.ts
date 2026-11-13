import { describe, expect, it } from 'vitest'
import { SearchIssues } from './jira-params'

describe('Jira suggestion search parameters', () => {
  const legacy = { jql: 'text ~ "400*"', siteId: 'site-a', limit: 30 }
  const suggestions = { query: '400', currentJql: 'ORDER BY updated DESC' }

  it('preserves the fallback query when a legacy host strips the new optional field', () => {
    const request = { ...legacy, suggestions }
    expect(SearchIssues.parse(request)).toEqual(request)
    expect(SearchIssues.omit({ suggestions: true }).parse(request)).toEqual(legacy)
    expect(SearchIssues.parse(legacy)).toEqual(legacy)
  })

  it.each([
    { query: '400 OR 1=1', currentJql: suggestions.currentJql },
    { query: '', currentJql: suggestions.currentJql },
    { query: '4'.repeat(8193), currentJql: suggestions.currentJql },
    { query: '400', currentJql: '' },
    { query: '400', currentJql: '界'.repeat(3000) }
  ])('rejects invalid suggestion parameters', (invalid) => {
    expect(SearchIssues.safeParse({ ...legacy, suggestions: invalid }).success).toBe(false)
  })
})
