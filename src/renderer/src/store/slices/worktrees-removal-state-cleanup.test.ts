import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  beginHugeRepoWarningProbe,
  clearHugeRepoWarningDismissalsForTests,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control-huge-repo-warning-dismissals'
import { getHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeLineage, makeTerminalTab, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

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

  it('retains huge-repo warning state when explicit removal fails', async () => {
    const store = createTestStore()
    const retained = makeWorktree({
      id: 'repo1::/path/retained',
      instanceId: 'retained-instance',
      repoId: 'repo1',
      path: '/path/retained'
    })
    store.setState({ worktreesByRepo: { repo1: [retained] } } as Partial<AppState>)
    const retainedProbe = beginHugeRepoWarningProbe(retained)
    expect(markHugeRepoWarningDismissed(retainedProbe)).toBe(true)
    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('delete failed'))

    const result = await store.getState().removeWorktree({ id: retained.id, executionHostId: null })

    expect(result).toEqual({ ok: false, error: 'delete failed' })
    expect(hasDismissedHugeRepoWarning(retainedProbe)).toBe(true)
  })

  it('cleans up hosted review link mutation bookkeeping for the removed worktree', async () => {
    const store = createTestStore()
    const removed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    const surviving = makeWorktree({
      id: 'repo1::/path/wt2',
      repoId: 'repo1',
      path: '/path/wt2'
    })
    store.setState({ worktreesByRepo: { repo1: [removed, surviving] } } as Partial<AppState>)
    await store.getState().updateWorktreeMeta(removed.id, { linkedBitbucketPR: 101 })
    await store.getState().updateWorktreeMeta(surviving.id, { linkedAzureDevOpsPR: 202 })

    expect(getHostedReviewLinkMutationGenerationForTests(removed.id)).toBeGreaterThan(0)
    expect(getHostedReviewLinkMutationGenerationForTests(surviving.id)).toBeGreaterThan(0)

    await store.getState().removeWorktree({ id: removed.id, executionHostId: null })

    expect(getHostedReviewLinkMutationGenerationForTests(removed.id)).toBe(0)
    expect(getHostedReviewLinkMutationGenerationForTests(surviving.id)).toBeGreaterThan(0)
  })

  it('cleans up expandedPaneByTabId/canExpandPaneByTabId for removed worktree tabs', async () => {
    const store = createTestStore()
    const removed = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const surviving = makeWorktree({ id: 'repo1::/path/wt2', repoId: 'repo1', path: '/path/wt2' })

    store.setState({
      worktreesByRepo: { repo1: [removed, surviving] },
      tabsByWorktree: {
        [removed.id]: [makeTerminalTab({ id: 'removed-tab', worktreeId: removed.id })],
        [surviving.id]: [makeTerminalTab({ id: 'surviving-tab', worktreeId: surviving.id })]
      },
      // Split panes write these even when false; removeWorktree used to strand them (only closeTab deleted them).
      expandedPaneByTabId: { 'removed-tab': true, 'surviving-tab': false },
      canExpandPaneByTabId: { 'removed-tab': false, 'surviving-tab': true }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: removed.id, executionHostId: null })

    expect(store.getState().expandedPaneByTabId).toEqual({ 'surviving-tab': false })
    expect(store.getState().canExpandPaneByTabId).toEqual({ 'surviving-tab': true })
  })

  it('cleans up automatic agent resume claims for removed worktree tabs', async () => {
    const store = createTestStore()
    const removed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    const surviving = makeWorktree({
      id: 'repo1::/path/wt2',
      repoId: 'repo1',
      path: '/path/wt2'
    })

    store.setState({
      worktreesByRepo: { repo1: [removed, surviving] },
      tabsByWorktree: {
        [removed.id]: [makeTerminalTab({ id: 'removed-tab', worktreeId: removed.id })],
        [surviving.id]: [makeTerminalTab({ id: 'surviving-tab', worktreeId: surviving.id })]
      },
      automaticAgentResumeClaimsByTabId: {
        'removed-tab': {
          worktreeId: removed.id,
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'removed-session' }
        },
        'surviving-tab': {
          worktreeId: surviving.id,
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'surviving-session' }
        }
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: removed.id, executionHostId: null })

    expect(store.getState().automaticAgentResumeClaimsByTabId).toEqual({
      'surviving-tab': {
        worktreeId: surviving.id,
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'surviving-session' }
      }
    })
  })

  it('purges the orphaned project that pointed at a destroyed runtime-owned SSH target', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const orphanedSetup = {
      id: 'setup-runtime-ssh',
      hostId: 'ssh:runtime-ssh-orca-1'
    } as unknown as AppState['projectHostSetups'][number]
    const userSshSetup = {
      id: 'setup-user-ssh',
      hostId: 'ssh:my-server'
    } as unknown as AppState['projectHostSetups'][number]
    const deleteProjectHostSetup = vi.fn().mockResolvedValue(null)
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      projectHostSetups: [orphanedSetup, userSshSetup],
      deleteProjectHostSetup
    } as unknown as Partial<AppState>)
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
    expect(deleteProjectHostSetup).toHaveBeenCalledTimes(1)
    expect(deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-runtime-ssh' })
  })

  it('cleans up editorDrafts for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/file.ts',
          relativePath: 'file.ts',
          language: 'typescript',
          isDirty: true,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: {
        'file-1': 'draft content for wt1',
        'file-2': 'draft content for another worktree'
      }
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(result).toEqual({ ok: true })
    // Draft for file-1 should be removed, draft for file-2 should remain
    expect(store.getState().editorDrafts).toEqual({
      'file-2': 'draft content for another worktree'
    })
  })

  it('cleans up the removed worktree lineage entry', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const childLineage = makeLineage({ worktreeId: wt.id })
    const siblingLineage = makeLineage({
      worktreeId: 'repo1::/path/wt2',
      worktreeInstanceId: 'sibling-instance'
    })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      worktreeLineageById: {
        [wt.id]: childLineage,
        'repo1::/path/wt2': siblingLineage
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(store.getState().worktreeLineageById).toEqual({
      'repo1::/path/wt2': siblingLineage
    })
  })

  it('cleans up markdownViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/readme.md',
          relativePath: 'readme.md',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      markdownViewMode: {
        'file-1': 'rich' as const,
        'file-2': 'source' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().markdownViewMode).toEqual({ 'file-2': 'source' })
  })

  it('cleans up editorViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorViewMode: {
        'file-1': 'changes' as const,
        'file-2': 'changes' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().editorViewMode).toEqual({ 'file-2': 'changes' })
  })

  it('cleans up markdownFrontmatterVisible for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/readme.md',
          relativePath: 'readme.md',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
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

  it('cleans up expandedDirs for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      expandedDirs: {
        'repo1::/path/wt1': new Set(['src', 'src/lib']),
        'repo1::/path/wt2': new Set(['test'])
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().expandedDirs).toEqual({
      'repo1::/path/wt2': new Set(['test'])
    })
  })

  it('cleans up dotfile visibility for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      showDotfilesByWorktree: {
        'repo1::/path/wt1': false,
        'repo1::/path/wt2': false
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().showDotfilesByWorktree).toEqual({
      'repo1::/path/wt2': false
    })
  })

  it('cleans up activeTabIdByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeTabIdByWorktree: {
        'repo1::/path/wt1': 'tab-1',
        'repo1::/path/wt2': 'tab-2'
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().activeTabIdByWorktree).toEqual({
      'repo1::/path/wt2': 'tab-2'
    })
  })

  it('cleans up tabBarOrderByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      tabBarOrderByWorktree: {
        'repo1::/path/wt1': ['tab-1', 'file-1', 'browser-1'],
        'repo1::/path/wt2': ['tab-2']
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().tabBarOrderByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
  })

  it('cleans up split-tab model state for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      pendingReconnectTabByWorktree: {
        'repo1::/path/wt1': ['tab-1'],
        'repo1::/path/wt2': ['tab-2']
      },
      unifiedTabsByWorktree: {
        'repo1::/path/wt1': [{ id: 'tab-1', worktreeId: 'repo1::/path/wt1' }],
        'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
      },
      groupsByWorktree: {
        'repo1::/path/wt1': [
          { id: 'group-1', worktreeId: 'repo1::/path/wt1', activeTabId: 'tab-1' }
        ],
        'repo1::/path/wt2': [
          { id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }
        ]
      },
      activeGroupIdByWorktree: {
        'repo1::/path/wt1': 'group-1',
        'repo1::/path/wt2': 'group-2'
      },
      layoutByWorktree: {
        'repo1::/path/wt1': { type: 'leaf', groupId: 'group-1' },
        'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().pendingReconnectTabByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
    expect(store.getState().unifiedTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
    })
    expect(store.getState().groupsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }]
    })
    expect(store.getState().activeGroupIdByWorktree).toEqual({
      'repo1::/path/wt2': 'group-2'
    })
    expect(store.getState().layoutByWorktree).toEqual({
      'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
    })
  })

  it('cleans up git caches for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      gitStatusByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitStatusHeadByWorktree: {
        'repo1::/path/wt1': 'head-1',
        'repo1::/path/wt2': 'head-2'
      },
      gitBranchLineTotalByWorktree: {
        'repo1::/path/wt1': { added: 24, removed: 3, mergeBase: 'base-1' },
        'repo1::/path/wt2': { added: 1, removed: 0, mergeBase: 'base-2' }
      },
      gitIgnoredPathsByWorktree: {
        'repo1::/path/wt1': ['dist/'],
        'repo1::/path/wt2': ['coverage/']
      },
      gitConflictOperationByWorktree: {
        'repo1::/path/wt1': 'merge',
        'repo1::/path/wt2': 'unknown'
      },
      trackedConflictPathsByWorktree: {
        'repo1::/path/wt1': { 'a.ts': 'both_modified' },
        'repo1::/path/wt2': { 'b.ts': 'both_modified' }
      },
      gitBranchChangesByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitBranchCompareSummaryByWorktree: {
        'repo1::/path/wt1': { status: 'ready' },
        'repo1::/path/wt2': { status: 'loading' }
      },
      gitBranchCompareRequestKeyByWorktree: {
        'repo1::/path/wt1': 'req-1',
        'repo1::/path/wt2': 'req-2'
      },
      gitBranchCompareRequestStatusHeadByWorktree: {
        'repo1::/path/wt1': 'head-1',
        'repo1::/path/wt2': 'head-2'
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().gitStatusByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitStatusHeadByWorktree).toEqual({
      'repo1::/path/wt2': 'head-2'
    })
    expect(store.getState().gitBranchLineTotalByWorktree).toEqual({
      'repo1::/path/wt2': { added: 1, removed: 0, mergeBase: 'base-2' }
    })
    expect(store.getState().gitIgnoredPathsByWorktree).toEqual({
      'repo1::/path/wt2': ['coverage/']
    })
    expect(store.getState().gitConflictOperationByWorktree).toEqual({
      'repo1::/path/wt2': 'unknown'
    })
    expect(store.getState().trackedConflictPathsByWorktree).toEqual({
      'repo1::/path/wt2': { 'b.ts': 'both_modified' }
    })
    expect(store.getState().gitBranchChangesByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitBranchCompareSummaryByWorktree).toEqual({
      'repo1::/path/wt2': { status: 'loading' }
    })
    expect(store.getState().gitBranchCompareRequestKeyByWorktree).toEqual({
      'repo1::/path/wt2': 'req-2'
    })
    expect(store.getState().gitBranchCompareRequestStatusHeadByWorktree).toEqual({
      'repo1::/path/wt2': 'head-2'
    })
  })

  it('clears recentlyClosedBrowserTabsByWorktree for the removed worktree', async () => {
    // Why: undo snapshots for a deleted worktree can never be restored, so removeWorktree clears the key (design §1.1).
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      recentlyClosedBrowserTabsByWorktree: {
        'repo1::/path/wt1': [{ workspace: { id: 'workspace-1' }, pages: [] }],
        'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    expect(store.getState().recentlyClosedBrowserTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
    })
  })

  it('skips editorDrafts shallow copy when no files belong to the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    const drafts = { 'file-2': 'some content' }
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [],
      editorDrafts: drafts
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: 'repo1::/path/wt1', executionHostId: null })

    // The same reference should be returned (no unnecessary shallow copy)
    expect(store.getState().editorDrafts).toBe(drafts)
  })
})
