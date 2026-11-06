import { describe, expect, it } from 'vitest'
import {
  MAX_JIRA_FAVOURITE_FILTER_LIST_BYTES,
  normalizeJiraFavouriteFilters,
  parseJiraFavouriteFilterList
} from './jira-favourite-filters'
import { JiraFavouriteFilterParams } from '../rpc-contract/jira-favourite-filter-params'

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

  it.each([null, {}, { values: [filter] }, 'filters'])('rejects invalid list %j', (value) => {
    expect(() => normalizeJiraFavouriteFilters(value, 'site-1')).toThrow('invalid')
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

  it('bounds the serialized envelope including JSON escape expansion', () => {
    const filters = Array.from({ length: 100 }, (_, index) => ({
      ...filter,
      id: String(index),
      jql: `x${'\u0000'.repeat(8190)}x`
    }))
    const result = normalizeJiraFavouriteFilters(filters, 'site-1')
    expect(result.filters.length).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_JIRA_FAVOURITE_FILTER_LIST_BYTES
    )
    expect(parseJiraFavouriteFilterList(result, 'site-1')).toEqual(result)
    expect(() =>
      parseJiraFavouriteFilterList(
        { filters: filters.map((item) => ({ ...item, siteId: 'site-1' })), truncated: false },
        'site-1'
      )
    ).toThrow('transfer limit')
  })
})

describe('Jira favourite filter transport contract', () => {
  it.each([undefined, {}, { siteId: 'all' }, { siteId: ' ' }, { siteId: 'x'.repeat(129) }])(
    'requires an explicit bounded single site: %j',
    (value) => expect(JiraFavouriteFilterParams.safeParse(value).success).toBe(false)
  )

  it('normalizes a supplied site without accepting additional arguments', () => {
    expect(JiraFavouriteFilterParams.parse({ siteId: ' site-1 ' })).toEqual({ siteId: 'site-1' })
    expect(JiraFavouriteFilterParams.safeParse({ siteId: 'site-1', limit: 1 }).success).toBe(false)
  })

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

  it.each([
    null,
    [],
    { filters: [] },
    { filters: [], truncated: 'false' },
    { filters: [{ ...filter, siteId: 'site-2' }], truncated: false },
    {
      filters: [
        { ...filter, siteId: 'site-1' },
        { ...filter, siteId: 'site-1' }
      ],
      truncated: false
    }
  ])('rejects malformed or cross-site transport envelopes: %j', (value) => {
    expect(() => parseJiraFavouriteFilterList(value, 'site-1')).toThrow()
  })
})
