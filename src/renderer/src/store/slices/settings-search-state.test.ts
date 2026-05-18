import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSettingsSearchState,
  SETTINGS_SEARCH_DEBOUNCE_MS,
  type SettingsSearchState
} from './settings-search-state'

function createTestSearchState(): {
  getState: () => SettingsSearchState
  setState: (state: Partial<SettingsSearchState>) => void
} {
  let state = {} as SettingsSearchState
  const setState = (updates: Partial<SettingsSearchState>): void => {
    state = { ...state, ...updates }
  }
  state = createSettingsSearchState(setState)
  return { getState: () => state, setState }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('settings search state', () => {
  it('updates the search input immediately and debounces the applied filter', () => {
    vi.useFakeTimers()
    const store = createTestSearchState()

    store.getState().setSettingsSearchQuery('terminal')

    expect(store.getState().settingsSearchInputQuery).toBe('terminal')
    expect(store.getState().settingsSearchQuery).toBe('')

    vi.advanceTimersByTime(SETTINGS_SEARCH_DEBOUNCE_MS - 1)
    expect(store.getState().settingsSearchQuery).toBe('')

    vi.advanceTimersByTime(1)
    expect(store.getState().settingsSearchQuery).toBe('terminal')
  })

  it('clears settings search immediately and cancels pending debounce work', () => {
    vi.useFakeTimers()
    const store = createTestSearchState()
    store.setState({ settingsSearchInputQuery: 'terminal', settingsSearchQuery: 'terminal' })

    store.getState().setSettingsSearchQuery('agents')
    vi.advanceTimersByTime(SETTINGS_SEARCH_DEBOUNCE_MS - 1)
    store.getState().setSettingsSearchQuery('')

    expect(store.getState().settingsSearchInputQuery).toBe('')
    expect(store.getState().settingsSearchQuery).toBe('')

    vi.advanceTimersByTime(SETTINGS_SEARCH_DEBOUNCE_MS)
    expect(store.getState().settingsSearchQuery).toBe('')
  })
})
