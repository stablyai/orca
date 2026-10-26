import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { isTerminalTabPresent } from './terminal-tab-retirement'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createStoreSessionMockApi } from './store-session-test-harness'

const WORKTREE_ID = 'repo1::/path/wt1'

beforeEach(() => {
  // Track the original global before the shared fixture installs the renderer API.
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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

    expect(remounted.remounted).toBe(true)
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

    expect(store.getState().remountTerminalTabForRecovery(tabId).remounted).toBe(true)

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

    expect(store.getState().remountTerminalTabForRecovery('missing-tab')).toEqual({
      remounted: false,
      declinedBy: 'tab-missing'
    })
  })
})

// Recovery budget must follow the terminal-row index; temporary unified-index absence previously released the budget on every remount (b5cfc6ca).
describe('isTerminalTabPresent as the recovery existence check', () => {
  it('answers true for a tab remountTerminalTabForRecovery can still remount', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)

    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(true)
    expect(store.getState().remountTerminalTabForRecovery(tabId).remounted).toBe(true)
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
    expect(store.getState().remountTerminalTabForRecovery(tabId).remounted).toBe(false)
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

// Recovery ledger follows tab rows across worktree, folder and floating buckets; no repository-only lookup may strand it.
describe.each([
  ['a repository worktree', WORKTREE_ID],
  ['a folder workspace', folderWorkspaceKey('fw-1')],
  ['the floating terminal bucket', FLOATING_TERMINAL_WORKTREE_ID]
])('the recovery ledger on %s', (_label, bucketId) => {
  function seedBucket(store: ReturnType<typeof createTestStore>): string {
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
      }
    })
    return store.getState().createTab(bucketId).id
  }

  const AUTOMATIC = { reason: 'write-stalled', trigger: 'automatic', now: 0 } as const

  it('admits, observes and then refuses the same reason until a new trigger', () => {
    const store = createTestStore()
    const tabId = seedBucket(store)
    const row = (): { recovery?: unknown } | undefined =>
      store.getState().tabsByWorktree[bucketId]?.find((tab) => tab.id === tabId)

    const first = store.getState().remountTerminalTabForRecovery(tabId, AUTOMATIC)
    expect(first.remounted).toBe(true)
    expect(row()?.recovery).toMatchObject({ outcome: 'pending', reason: 'write-stalled' })

    // Unsettled blocks the next automatic ask, even past the cooldown.
    expect(
      store.getState().remountTerminalTabForRecovery(tabId, { ...AUTOMATIC, now: 16_000 })
    ).toEqual({ remounted: false, declinedBy: 'unsettled', retryInMs: 15_000 })

    if (!first.remounted) {
      throw new Error('unreachable: the first remount was admitted')
    }
    store.getState().settleTerminalTabRecovery(tabId, first.generation, 'failed')
    expect(row()?.recovery).toMatchObject({ outcome: 'failed' })
    expect(
      store.getState().remountTerminalTabForRecovery(tabId, { ...AUTOMATIC, now: 600_000 })
    ).toEqual({ remounted: false, declinedBy: 'settled-failure' })

    // The user asking again is the new trigger the refusal waits for.
    expect(
      store
        .getState()
        .remountTerminalTabForRecovery(tabId, { ...AUTOMATIC, trigger: 'user', now: 600_000 })
        .remounted
    ).toBe(true)
  })

  it('drops the ledger with the row when the tab closes', () => {
    const store = createTestStore()
    const tabId = seedBucket(store)
    store.getState().remountTerminalTabForRecovery(tabId, AUTOMATIC)

    store.getState().closeTab(tabId)

    expect(isTerminalTabPresent(store.getState(), tabId)).toBe(false)
    expect(store.getState().tabsByWorktree[bucketId]?.some((tab) => tab.id === tabId)).toBeFalsy()
  })
})

// Pane mount snapshots startup commands once; recovery must retain queued commands until owning-pane spawn or leave quick commands at a bare prompt (STA-4876).
describe('queued startup command retention', () => {
  it('survives a recovery remount so the next mount can still deliver it', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Commands are tab-scoped but binds are pane-scoped; a sibling’s earlier bind must not consume the owner’s remount command.
  it('is not spent by a sibling pane binding a pty to the same tab', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().updateTabPtyId(tabId, 'pty-sibling')

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Only the owning pane spends it, via this action, once its own fresh spawn exists.
  it('is spent through consumeTabStartupCommand and does not replay afterwards', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    expect(store.getState().consumeTabStartupCommand(tabId)).toEqual({ command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(store.getState().consumeTabStartupCommand(tabId)).toBeNull()
  })

  // Why: retention is bounded by tab lifetime, so a spawn that never binds cannot leak forever.
  it('is dropped when the tab closes without ever spawning', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().closeTab(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
  })

  it('leaves a sibling tab’s queued command alone', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const siblingId = store.getState().createTab(WORKTREE_ID).id
    store.getState().queueTabStartupCommand(tabId, { command: 'echo mine' })
    store.getState().queueTabStartupCommand(siblingId, { command: 'echo theirs' })

    store.getState().consumeTabStartupCommand(tabId)

    expect(store.getState().pendingStartupByTabId[siblingId]).toEqual({ command: 'echo theirs' })
  })
})
