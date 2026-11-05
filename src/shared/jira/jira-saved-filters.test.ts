import { describe, expect, it } from 'vitest'
import {
  mutateJiraSavedFilterState,
  normalizeJiraSavedFilterState,
  MAX_JIRA_SAVED_FILTERS
} from './jira-saved-filters'
const mine = { id: 'mine', name: 'My work', jql: 'assignee = currentUser()' }
const bugs = { id: 'bugs', name: 'Bugs', jql: 'project = APP AND type = Bug' }

describe('host Jira saved filters', () => {
  it('retains several named queries and the selection through serialization', () => {
    let state = mutateJiraSavedFilterState(undefined, { kind: 'save', filter: mine })
    state = mutateJiraSavedFilterState(state, { kind: 'save', filter: bugs })
    state = mutateJiraSavedFilterState(state, { kind: 'select', id: bugs.id })
    expect(normalizeJiraSavedFilterState(JSON.parse(JSON.stringify(state)))).toEqual({
      filters: [mine, bugs],
      activeFilterId: bugs.id
    })
  })
  it('updates and renames only the targeted filter and clears a deleted selection', () => {
    const initial = { filters: [mine, bugs], activeFilterId: mine.id }
    const renamed = { ...mine, name: 'Active work', jql: 'status = Open' }
    const updated = mutateJiraSavedFilterState(initial, { kind: 'save', filter: renamed })
    expect(updated).toEqual({ filters: [renamed, bugs], activeFilterId: mine.id })
    expect(initial.filters[0]).toEqual(mine)
    expect(mutateJiraSavedFilterState(updated, { kind: 'delete', id: mine.id })).toEqual({
      filters: [bugs],
      activeFilterId: null
    })
  })
  it('never silently overwrites duplicate names or corrupts filters after rejected edits', () => {
    const initial = { filters: [mine, bugs], activeFilterId: mine.id }
    expect(() =>
      mutateJiraSavedFilterState(initial, { kind: 'save', filter: { ...mine, name: ' bugs ' } })
    ).toThrow('already exists')
    expect(() =>
      mutateJiraSavedFilterState(initial, { kind: 'save', filter: { ...mine, jql: '' } })
    ).toThrow('Invalid')
    expect(initial.filters).toEqual([mine, bugs])
    // Jira validates syntax when the stored text is run, not while it is saved.
    expect(
      mutateJiraSavedFilterState(initial, { kind: 'save', filter: { ...mine, jql: 'invalid JQL' } })
        .filters[0]?.jql
    ).toBe('invalid JQL')
  })
  it('bounds malformed persisted values, removes duplicate IDs and clears dangling selections', () => {
    expect(
      normalizeJiraSavedFilterState({
        filters: [mine, null, { ...bugs, id: mine.id }, { ...bugs, name: ' my work ' }, bugs],
        activeFilterId: 'missing'
      })
    ).toEqual({ filters: [mine, bugs], activeFilterId: null })
    const filters = Array.from({ length: MAX_JIRA_SAVED_FILTERS }, (_, index) => ({
      ...mine,
      id: String(index),
      name: String(index)
    }))
    expect(() => mutateJiraSavedFilterState({ filters }, { kind: 'save', filter: bugs })).toThrow(
      'limit'
    )
    expect(() =>
      mutateJiraSavedFilterState({ filters: [mine] }, { kind: 'select', id: 'deleted' })
    ).toThrow('no longer exists')
  })
})
