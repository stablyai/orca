import { describe, expect, it, vi } from 'vitest'
import type { SideQuestSessionReference } from '../../../../shared/side-quest-types'
import { createTestStore, makeTab } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// @ts-expect-error -- partial preload stub is sufficient for this store-only test.
globalThis.window = { api: {} }

const WORKTREE_ID = 'repo1::/tmp/side-quest'
const TAB_ID = 'side-quest-tab'

function reference(overrides: Partial<SideQuestSessionReference> = {}): SideQuestSessionReference {
  return {
    id: 'side-quest-1',
    provider: 'codex',
    providerThreadId: null,
    status: 'starting',
    error: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

describe('terminal Side Quest session reference', () => {
  it('sets, updates, and clears only the targeted terminal tab', () => {
    const store = createTestStore()
    const sibling = makeTab({ id: 'sibling-tab', worktreeId: WORKTREE_ID })
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID }), sibling]
      }
    })

    const starting = reference()
    store.getState().setTabSideQuestSession(TAB_ID, starting)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].sideQuestSession).toBe(starting)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][1]).toBe(sibling)

    const ready = reference({ providerThreadId: 'thread-1', status: 'ready', updatedAt: 200 })
    store.getState().setTabSideQuestSession(TAB_ID, ready)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].sideQuestSession).toBe(ready)

    store.getState().setTabSideQuestSession(TAB_ID, null)
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0]).not.toHaveProperty('sideQuestSession')
  })

  it('does not update state for an unknown tab', () => {
    const store = createTestStore()
    const tabsByWorktree = {
      [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })]
    }
    store.setState({ tabsByWorktree })

    store.getState().setTabSideQuestSession('missing-tab', reference())

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
  })
})
