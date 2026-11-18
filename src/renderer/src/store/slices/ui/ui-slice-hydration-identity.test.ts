import { describe, expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from './persisted-ui-write-baseline'

describe('persisted UI hydration', () => {
  it('keeps unchanged fields when one field changes, as when main echoes a write', () => {
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
        sidebarWidth: 320
      })
    )

    const state = store.getState()
    expect(state.sidebarWidth).toBe(320)
    expect(state.collapsedGroups).toBe(collapsedGroups)
    // A kept field must still read as saved, or the writer would resend it.
    expect(
      diffPersistedUIWriteFields(
        capturePersistedUIWriteBaseline(state),
        state.persistedUIWriteBaseline!
      )
    ).toEqual({})
  })
})
