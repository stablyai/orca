import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../../worktrees-slice-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

describe('worktree no-op notifications', () => {
  it('keeps missing creation, recovery, activity, deletion and visit updates silent', () => {
    const store = createTestStore()
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    before.updatePendingWorktreeCreation('missing', { phase: 'fetching' })
    before.removePendingWorktreeCreation('missing')
    before.setActivePendingWorktreeCreation('missing')
    before.remountTerminalTabForRecovery('missing')
    before.settleTerminalTabRecovery('missing', 1, 'success')
    before.markWorktreeUnread('missing')
    before.bumpWorktreeActivity('missing')
    before.clearWorktreeDeleteState('missing')
    before.seedActiveWorktreeLastVisitedIfMissing()
    before.pruneLastVisitedTimestamps()
    before.migrateWorktreeIdentity('missing-old', 'missing-new')

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['local', 'ssh:test'] as const)(
    'keeps repeated %s deletion and visit updates silent',
    (hostId) => {
      const store = createTestStore()
      const worktree = makeWorktree({ id: 'repo1::/path/wt', repoId: 'repo1', hostId })
      store.setState({ worktreesByRepo: { repo1: [worktree] } })
      const target = { id: worktree.id, hostId }
      store.getState().markWorktreesQueuedForDeletion([target])
      store.getState().markWorktreeVisited(worktree.id, 100, hostId)
      const before = store.getState()
      const listener = vi.fn()
      store.subscribe(listener)

      before.markWorktreesQueuedForDeletion([target])
      before.markWorktreeVisited(worktree.id, 100, hostId)
      before.markWorktreeVisited(worktree.id, 99, hostId)
      expect(store.getState()).toBe(before)
      expect(listener).not.toHaveBeenCalled()

      before.markWorktreesDeleting([target])
      expect(listener).toHaveBeenCalledTimes(1)
      const deleting = store.getState()
      deleting.markWorktreesDeleting([target])
      expect(store.getState()).toBe(deleting)
      expect(listener).toHaveBeenCalledTimes(1)
      deleting.clearWorktreeDeleteState(worktree.id, hostId)
      expect(listener).toHaveBeenCalledTimes(2)
    }
  )
})
