import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'

function seedWorktreeWithTab(store: ReturnType<typeof createTestStore>): string {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

describe('remountTerminalTabForRecovery', () => {
  it('bumps the tab generation so TerminalPane remounts', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const before = store.getState().tabsByWorktree[WORKTREE_ID].find((tab) => tab.id === tabId)

    const remounted = store.getState().remountTerminalTabForRecovery(tabId)

    expect(remounted).toBe(true)
    const after = store.getState().tabsByWorktree[WORKTREE_ID].find((tab) => tab.id === tabId)
    expect(after?.generation ?? 0).toBe((before?.generation ?? 0) + 1)
    // Recovery is not user interaction — the remount's PTY updates must not
    // reshuffle Recent, mirroring the activation-time generation bump.
    expect(after?.pendingActivationSpawn).toBeTruthy()
  })

  it('leaves sibling tabs untouched', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const siblingId = store.getState().createTab(WORKTREE_ID).id

    store.getState().remountTerminalTabForRecovery(tabId)

    const sibling = store.getState().tabsByWorktree[WORKTREE_ID].find((tab) => tab.id === siblingId)
    expect(sibling?.generation ?? 0).toBe(0)
    expect(sibling?.pendingActivationSpawn).toBeFalsy()
  })

  it('returns false when the tab no longer exists', () => {
    const store = createTestStore()
    seedWorktreeWithTab(store)

    expect(store.getState().remountTerminalTabForRecovery('missing-tab')).toBe(false)
  })
})
