import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import './terminal-tab-retirement'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createStoreSessionMockApi } from '../testing/app-store-session-api.test-fixture'

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
})

// Pane mount snapshots startup commands once; recovery must retain queued commands until owning-pane spawn or leave quick commands at a bare prompt (STA-4876).
describe('queued startup command retention', () => {
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
})
