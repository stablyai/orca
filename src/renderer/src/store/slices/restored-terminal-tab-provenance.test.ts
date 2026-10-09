import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

describe('restored terminal tab provenance', () => {
  it('clears restoredFromPersistence when the restored pane binds its PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'tab-1',
            worktreeId,
            pendingActivationSpawn: true,
            restoredFromPersistence: true
          })
        ]
      }
    })

    store.getState().updateTabPtyId('tab-1', 'remote:env-1@@terminal-1')

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab?.ptyId).toBe('remote:env-1@@terminal-1')
    expect(tab && 'restoredFromPersistence' in tab).toBe(false)
  })
})
