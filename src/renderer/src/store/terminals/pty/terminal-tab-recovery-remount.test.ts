import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'
import '../retirement/terminal-tab-retirement'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { createStoreSessionMockApi } from '../../testing/app-store-session-api.test-fixture'

const WORKTREE_ID = 'repo1::/path/wt1'

beforeEach(() => {
  // Track the original global before the shared fixture installs the renderer API.
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([['a folder workspace', folderWorkspaceKey('fw-1')]])(
  'the recovery ledger on %s',
  (_label, bucketId) => {
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
  }
)
