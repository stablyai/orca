import { describe, expect, it } from 'vitest'
import {
  MAX_JIRA_CUSTOM_FILTERS,
  normalizeJiraCustomFilters,
  resolveActiveJiraFilterJql,
  resolveJiraFilterViewState,
  type JiraCustomFilter
} from './jira-custom-filters'

function makeFilter(id: string): JiraCustomFilter {
  return { id, name: `Filter ${id}`, jql: `labels = ${id}` }
}

describe('normalizeJiraCustomFilters', () => {
  it('keeps well-formed filters and trims fields', () => {
    expect(
      normalizeJiraCustomFilters([{ id: ' a ', name: ' My bugs ', jql: ' project = ALP ' }])
    ).toEqual([{ id: 'a', name: 'My bugs', jql: 'project = ALP' }])
  })

  it('drops malformed entries, blank fields, and duplicate ids', () => {
    expect(
      normalizeJiraCustomFilters([
        null,
        'nope',
        { id: 'a', name: '', jql: 'x' },
        { id: 'a', name: 'No JQL' },
        { id: '', name: 'No id', jql: 'x' },
        { id: 'a', name: 'First', jql: 'x' },
        { id: 'a', name: 'Duplicate', jql: 'y' }
      ])
    ).toEqual([{ id: 'a', name: 'First', jql: 'x' }])
  })

  it('caps the list and tolerates non-array input', () => {
    const oversized = Array.from({ length: MAX_JIRA_CUSTOM_FILTERS + 5 }, (_, index) =>
      makeFilter(String(index))
    )
    expect(normalizeJiraCustomFilters(oversized)).toHaveLength(MAX_JIRA_CUSTOM_FILTERS)
    expect(normalizeJiraCustomFilters({ not: 'a list' })).toEqual([])
  })
})

describe('resolveJiraFilterViewState', () => {
  it('drops an active custom ref whose filter no longer exists', () => {
    expect(
      resolveJiraFilterViewState({
        customFilters: [makeFilter('a')],
        activeFilter: { source: 'custom', id: 'missing' }
      })
    ).toEqual({ customFilters: [makeFilter('a')] })
  })

  it('keeps an active saved ref with its snapshot', () => {
    const activeFilter = {
      source: 'saved',
      siteId: 'site-1',
      filterId: '10001',
      name: 'Team backlog',
      jql: 'project = ALP'
    }
    expect(resolveJiraFilterViewState({ customFilters: [], activeFilter })).toEqual({
      customFilters: [],
      activeFilter
    })
  })

  it('rejects saved refs missing their executable snapshot and garbage input', () => {
    expect(
      resolveJiraFilterViewState({
        activeFilter: { source: 'saved', siteId: 'site-1', filterId: '10001', name: 'x', jql: '' }
      })
    ).toEqual({ customFilters: [] })
    expect(resolveJiraFilterViewState('garbage')).toEqual({ customFilters: [] })
    expect(resolveJiraFilterViewState(undefined)).toEqual({ customFilters: [] })
  })
})

describe('resolveActiveJiraFilterJql', () => {
  it('returns the snapshot JQL for saved filters', () => {
    expect(
      resolveActiveJiraFilterJql(
        { source: 'saved', siteId: 's', filterId: 'f', name: 'n', jql: 'project = ALP' },
        []
      )
    ).toBe('project = ALP')
  })

  it('resolves custom filters by id and degrades to null when deleted', () => {
    const filters = [makeFilter('a')]
    expect(resolveActiveJiraFilterJql({ source: 'custom', id: 'a' }, filters)).toBe('labels = a')
    expect(resolveActiveJiraFilterJql({ source: 'custom', id: 'gone' }, filters)).toBeNull()
    expect(resolveActiveJiraFilterJql(null, filters)).toBeNull()
  })
})
