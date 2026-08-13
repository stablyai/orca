// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadJiraFilterViewState, saveJiraFilterViewState } from './jira-custom-filters-storage'

const STORAGE_KEY = 'orca.jira.custom-filters.v1'

describe('Jira custom filters local storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to an empty state when nothing is stored or the payload is corrupt', () => {
    expect(loadJiraFilterViewState()).toEqual({ customFilters: [] })

    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadJiraFilterViewState()).toEqual({ customFilters: [] })
  })

  it('round-trips custom filters and the active selection', () => {
    const state = {
      customFilters: [{ id: 'a', name: 'My bugs', jql: 'type = Bug' }],
      activeFilter: { source: 'custom' as const, id: 'a' }
    }

    saveJiraFilterViewState(state)

    expect(loadJiraFilterViewState()).toEqual(state)
  })

  it('clears the key when the state becomes empty', () => {
    saveJiraFilterViewState({ customFilters: [{ id: 'a', name: 'My bugs', jql: 'type = Bug' }] })

    saveJiraFilterViewState({ customFilters: [] })

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadJiraFilterViewState()).toEqual({ customFilters: [] })
  })

  it('drops an active ref pointing at a deleted custom filter on save', () => {
    saveJiraFilterViewState({
      customFilters: [{ id: 'a', name: 'My bugs', jql: 'type = Bug' }],
      activeFilter: { source: 'custom', id: 'deleted' }
    })

    expect(loadJiraFilterViewState()).toEqual({
      customFilters: [{ id: 'a', name: 'My bugs', jql: 'type = Bug' }]
    })
  })
})
