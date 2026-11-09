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
  mockApi,
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

  it('purges the orphaned project that pointed at a destroyed runtime-owned SSH target', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const orphanedSetup: AppState['projectHostSetups'][number] = {
      id: 'setup-runtime-ssh',
      hostId: 'ssh:runtime-ssh-orca-1',
      projectId: 'project-runtime-ssh',
      repoId: 'repo-runtime-ssh',
      path: '/runtime/repo',
      displayName: 'Runtime repo',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    const userSshSetup: AppState['projectHostSetups'][number] = {
      id: 'setup-user-ssh',
      hostId: 'ssh:my-server',
      projectId: 'project-user-ssh',
      repoId: 'repo-user-ssh',
      path: '/user/repo',
      displayName: 'User repo',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    const deleteProjectHostSetup = vi.fn().mockResolvedValue(null)
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      projectHostSetups: [orphanedSetup, userSshSetup],
      deleteProjectHostSetup
    })
    mockApi.ephemeralVm.listRuntimes.mockResolvedValueOnce([
      {
        id: 'runtime-1',
        workspaceId: 'repo1::/path/wt1',
        cleanupStatus: 'not_started',
        sshTargetId: 'runtime-ssh-orca-1'
      }
    ])

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    // Only the orphaned runtime-owned project setup is purged; the user's SSH project is untouched.
    expect(deleteProjectHostSetup).toHaveBeenCalledWith({
      setupId: 'setup-runtime-ssh',
      hostId: 'ssh:runtime-ssh-orca-1'
    })
  })

  it('cleans up markdownFrontmatterVisible for preview-only source files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'markdown-preview::file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/readme.md',
          relativePath: 'readme.md',
          language: 'markdown',
          isDirty: false,
          markdownPreviewSourceFileId: 'file-1',
          mode: 'markdown-preview' as const
        }
      ],
      markdownFrontmatterVisible: {
        'file-1': true,
        'file-2': true
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().markdownFrontmatterVisible).toEqual({ 'file-2': true })
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
