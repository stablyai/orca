import { describe, expect, it } from 'vitest'
import {
  MAX_JIRA_SAVED_FILTERS,
  MAX_JIRA_SAVED_FILTER_ID_LENGTH,
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  normalizeJiraSavedFilters
} from './jira-saved-filters'

describe('normalizeJiraSavedFilters', () => {
  it('defines bounded persisted filter limits', () => {
    expect(MAX_JIRA_SAVED_FILTERS).toBe(50)
    expect(MAX_JIRA_SAVED_FILTER_ID_LENGTH).toBe(128)
    expect(MAX_JIRA_SAVED_FILTER_NAME_LENGTH).toBe(80)
    expect(MAX_JIRA_SAVED_FILTER_JQL_LENGTH).toBe(10_000)
  })

  it('trims valid persisted filters', () => {
    expect(
      normalizeJiraSavedFilters([
        { id: ' filter-1 ', name: ' My open work ', jql: ' assignee = currentUser() ' }
      ])
    ).toEqual([{ id: 'filter-1', name: 'My open work', jql: 'assignee = currentUser()' }])
  })

  it('drops malformed and out-of-bounds entries', () => {
    expect(
      normalizeJiraSavedFilters([
        null,
        [],
        { id: '', name: 'Empty id', jql: 'project = ENG' },
        { id: 'id', name: '', jql: 'project = ENG' },
        { id: 'jql', name: 'Empty JQL', jql: ' ' },
        { id: 'x'.repeat(MAX_JIRA_SAVED_FILTER_ID_LENGTH + 1), name: 'Long id', jql: 'x' },
        { id: 'name', name: 'x'.repeat(MAX_JIRA_SAVED_FILTER_NAME_LENGTH + 1), jql: 'x' },
        { id: 'jql-long', name: 'Long JQL', jql: 'x'.repeat(MAX_JIRA_SAVED_FILTER_JQL_LENGTH + 1) },
        { id: 'valid', name: 'Valid', jql: 'project = ENG' }
      ])
    ).toEqual([{ id: 'valid', name: 'Valid', jql: 'project = ENG' }])
    expect(normalizeJiraSavedFilters({})).toEqual([])
  })

  it('keeps the first filter for duplicate ids and case-insensitive names', () => {
    expect(
      normalizeJiraSavedFilters([
        { id: 'one', name: 'My Bugs', jql: 'one' },
        { id: 'one', name: 'Different', jql: 'duplicate id' },
        { id: 'two', name: ' my bugs ', jql: 'duplicate name' },
        { id: 'three', name: 'Done', jql: 'three' }
      ])
    ).toEqual([
      { id: 'one', name: 'My Bugs', jql: 'one' },
      { id: 'three', name: 'Done', jql: 'three' }
    ])
  })

  it('caps the normalized list after filtering invalid entries', () => {
    const persisted = [
      { id: '', name: 'invalid', jql: 'invalid' },
      ...Array.from({ length: MAX_JIRA_SAVED_FILTERS + 5 }, (_, index) => ({
        id: `filter-${index}`,
        name: `Filter ${index}`,
        jql: `project = P${index}`
      }))
    ]

    const normalized = normalizeJiraSavedFilters(persisted)

    expect(normalized).toHaveLength(MAX_JIRA_SAVED_FILTERS)
    expect(normalized.at(-1)?.id).toBe(`filter-${MAX_JIRA_SAVED_FILTERS - 1}`)
  })
})
