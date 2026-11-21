import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from './persisted-ui-write-baseline'

describe('persisted UI hydration', () => {
  it('keeps unchanged fields and restores an old activity cutoff on sync', () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const now = Date.UTC(2026, 10, 18)
    vi.setSystemTime(now)
    const clearedAt = now - 22 * 24 * 60 * 60 * 1000

    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        collapsedGroups: ['repo:a'],
        gitGraphFiltersByWorktree: { a: 'all', b: 'head' },
        sidebarWidth: 300
      }),
      'startup'
    )
    const collapsedGroups = store.getState().collapsedGroups

    store.getState().hydratePersistedUI(
      makePersistedUI({
        collapsedGroups: ['repo:a'],
        gitGraphFiltersByWorktree: { b: 'head', a: 'all' },
        sidebarWidth: 320,
        activityClearedAtByPaneKey: { 'tab-1:leaf-1': clearedAt }
      })
    )

    const state = store.getState()
    expect(state.sidebarWidth).toBe(320)
    expect(state.collapsedGroups).toBe(collapsedGroups)
    expect(state.activityClearedAtByPaneKey).toEqual({ 'tab-1:leaf-1': clearedAt })
    // A kept field must still read as saved, or the writer would resend it.
    expect(
      diffPersistedUIWriteFields(
        capturePersistedUIWriteBaseline(state),
        state.persistedUIWriteBaseline!
      )
    ).toEqual({})
  })
})
