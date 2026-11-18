import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 18)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('activity clear cutoff hydration', () => {
  it('keeps a cutoff stamped from a turn older than the status retention window', () => {
    // Structured chat rows hydrate at any age, so clearing a 22-day-old failed turn must survive restart.
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ activityClearedAtByPaneKey: { 'tab-1:leaf-1': NOW - 22 * DAY_MS } })
      )
    expect(store.getState().activityClearedAtByPaneKey).toEqual({
      'tab-1:leaf-1': NOW - 22 * DAY_MS
    })
  })
})
