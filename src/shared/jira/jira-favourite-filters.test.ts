import { describe, expect, it } from 'vitest'
import {
  normalizeJiraFavouriteFilters,
  parseJiraFavouriteFilterList
} from './jira-favourite-filters'

const filter = { id: '123', name: 'My work', jql: 'assignee = currentUser()' }

describe('Jira favourite filter normalization', () => {
  it('keeps only query fields and stamps the authenticated site', () => {
    expect(
      normalizeJiraFavouriteFilters(
        [{ ...filter, siteId: 'foreign-site', owner: { email: 'private@example.com' } }],
        'site-1'
      )
    ).toEqual({ filters: [{ ...filter, siteId: 'site-1' }], truncated: false })
  })

  it('deduplicates IDs without discarding distinct filters with the same name', () => {
    const result = normalizeJiraFavouriteFilters(
      [filter, { ...filter, jql: 'project = OTHER' }, { ...filter, id: '456' }],
      'site-1'
    )
    expect(result.filters.map((item) => item.id)).toEqual(['123', '456'])
    expect(result.truncated).toBe(false)
  })

  it('normalizes positive safe-integer API IDs before deduplicating them', () => {
    expect(normalizeJiraFavouriteFilters([{ ...filter, id: 123 }, filter], 'site-1')).toEqual({
      filters: [{ ...filter, siteId: 'site-1' }],
      truncated: false
    })
  })

  it('marks malformed or oversized filters as omitted without changing their queries', () => {
    const bad = [
      null,
      [],
      { ...filter, id: 1.2 },
      { ...filter, id: 0 },
      { ...filter, id: -1 },
      { ...filter, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...filter, id: 'x'.repeat(129) },
      { ...filter, name: 'x'.repeat(201) },
      { ...filter, jql: ' ' },
      { ...filter, jql: 'é'.repeat(4097) },
      { ...filter, jql: 'x'.repeat(8193) }
    ]
    expect(normalizeJiraFavouriteFilters([...bad, filter], 'site-1')).toEqual({
      filters: [{ ...filter, siteId: 'site-1' }],
      truncated: true
    })
    expect(
      normalizeJiraFavouriteFilters([{ ...filter, jql: 'é'.repeat(4096) }], 'site-1').filters
    ).toHaveLength(1)
  })

  it('caps results and omits a valid filter beyond the candidate limit', () => {
    const filters = Array.from({ length: 101 }, (_, index) => ({ ...filter, id: String(index) }))
    const result = normalizeJiraFavouriteFilters(filters, 'site-1')
    expect(result.filters).toHaveLength(100)
    expect(result.truncated).toBe(true)
    expect(normalizeJiraFavouriteFilters([...Array(1000).fill(null), filter], 'site-1')).toEqual({
      filters: [],
      truncated: true
    })
  })
})

describe('Jira favourite filter transport contract', () => {
  it('accepts additive future response fields without exposing them to callers', () => {
    expect(
      parseJiraFavouriteFilterList(
        {
          filters: [{ ...filter, siteId: 'site-1', futureRowField: true }],
          truncated: false,
          nextPage: null
        },
        'site-1'
      )
    ).toEqual({ filters: [{ ...filter, siteId: 'site-1' }], truncated: false })
  })
})
