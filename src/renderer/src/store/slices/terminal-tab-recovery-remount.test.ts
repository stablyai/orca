import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { isTerminalTabPresent } from './terminal-tab-retirement'

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

  it('gives a remounted pane a distinct queued startup owner', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const startup = { command: 'echo recover' }
    store.getState().queueTabStartupCommand(tabId, startup)
    const before = store.getState().pendingStartupByTabId[tabId]

    expect(store.getState().remountTerminalTabForRecovery(tabId)).toBe(true)

    const after = store.getState().pendingStartupByTabId[tabId]
    expect(after).toEqual(before)
    expect(after).not.toBe(before)
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

// Crash b5cfc6ca: recovery released its per-tab remount budget from getTab, which
// reads unifiedTabsByWorktree. That index can drop a tab this one still holds, and
// the release then erased the budget each remount had just consumed.
describe('isTerminalTabPresent as the recovery existence check', () => {
  it('answers true for a tab remountTerminalTabForRecovery can still remount', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)

    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(true)
    expect(store.getState().remountTerminalTabForRecovery(tabId)).toBe(true)
  })

  it('stays true when the tab is missing from the unified tab index', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.setState({ unifiedTabsByWorktree: {} })

    expect(store.getState().getTab(tabId)).toBeNull()
    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(true)
  })

  it('answers false once the tab leaves the remount index', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.setState({ tabsByWorktree: { [WORKTREE_ID]: [] } })

    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(false)
    expect(store.getState().remountTerminalTabForRecovery(tabId)).toBe(false)
  })

  // The budget release still has to fire for a real close, or a closed tab's
  // timestamps and pending retry outlive it.
  it('answers false after a genuine closeTab', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)

    store.getState().closeTab(tabId)

    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(false)
  })
})
