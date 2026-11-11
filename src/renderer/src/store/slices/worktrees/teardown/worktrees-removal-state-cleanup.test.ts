import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import {
  beginHugeRepoWarningProbe,
  clearHugeRepoWarningDismissalsForTests,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import '../create-worktree-slice'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('removeWorktree state cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('invalidates huge-repo warning probes after successful explicit removal', async () => {
    const store = createTestStore()
    const removed = makeWorktree({
      id: 'repo1::/path/reused',
      instanceId: 'persisted-instance',
      repoId: 'repo1',
      path: '/path/reused'
    })
    store.setState({ worktreesByRepo: { repo1: [removed] } } as Partial<AppState>)
    const staleProbe = beginHugeRepoWarningProbe(removed)
    expect(markHugeRepoWarningDismissed(staleProbe)).toBe(true)

    await store.getState().removeWorktree({ id: removed.id, executionHostId: null })

    // The same-path replacement can reuse persisted instance metadata.
    const replacementProbe = beginHugeRepoWarningProbe({ ...removed })
    expect(hasDismissedHugeRepoWarning(staleProbe)).toBe(false)
    expect(markHugeRepoWarningDismissed(staleProbe)).toBe(false)
    expect(hasDismissedHugeRepoWarning(replacementProbe)).toBe(false)
  })

  it('records the sidebar scroll anchor in the same tick it removes the worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    const sidebar = new EventTarget()
    let worktreePresentWhenRecorded: boolean | null = null
    sidebar.addEventListener('orca-record-virtualized-scroll-anchor', () => {
      worktreePresentWhenRecorded =
        store.getState().worktreesByRepo.repo1?.some((w) => w.id === wt.id) ?? false
    })
    const globalWithDocument = globalThis as { document?: unknown }
    const originalDocument = globalWithDocument.document
    globalWithDocument.document = {
      querySelector: (selector: string) => (selector === '[data-worktree-sidebar]' ? sidebar : null)
    }

    try {
      await store.getState().removeWorktree({ id: wt.id, executionHostId: null })
    } finally {
      globalWithDocument.document = originalDocument
    }

    // The anchor must be captured while the row still exists so restore pins the pre-removal position.
    expect(worktreePresentWhenRecorded).toBe(true)
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
  })
})
