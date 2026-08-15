import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSpaceAnalysis } from '../../../../shared/workspace-space-types'
import type { AppState } from '../types'
import { createWorkspaceSpaceSlice } from './workspace-space'

function createWorkspaceSpaceTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createWorkspaceSpaceSlice(...a)
      }) as unknown as AppState
  )
}

function makeAnalysis(): WorkspaceSpaceAnalysis {
  return {
    scannedAt: 1,
    totalSizeBytes: 300,
    reclaimableBytes: 300,
    worktreeCount: 2,
    scannedWorktreeCount: 2,
    unavailableWorktreeCount: 0,
    repos: [
      {
        repoId: 'repo-1',
        displayName: 'orca',
        path: '/repo/main',
        isRemote: false,
        worktreeCount: 2,
        scannedWorktreeCount: 2,
        unavailableWorktreeCount: 0,
        totalSizeBytes: 300,
        reclaimableBytes: 300,
        error: null
      }
    ],
    worktrees: [
      {
        worktreeId: 'repo-1::/repo/main',
        repoId: 'repo-1',
        repoDisplayName: 'orca',
        repoPath: '/repo/main',
        displayName: 'main',
        path: '/repo/main',
        branch: 'refs/heads/main',
        isMainWorktree: true,
        isRemote: false,
        isSparse: false,
        status: 'ok',
        error: null,
        sizeBytes: 100,
        reclaimableBytes: 0,
        canDelete: false,
        lastActivityAt: 0,
        scannedAt: 1,
        skippedEntryCount: 0,
        topLevelItems: [],
        omittedTopLevelItemCount: 0,
        omittedTopLevelSizeBytes: 0
      },
      {
        worktreeId: 'repo-1::/repo/feature',
        repoId: 'repo-1',
        repoDisplayName: 'orca',
        repoPath: '/repo/main',
        displayName: 'feature',
        path: '/repo/feature',
        branch: 'refs/heads/feature',
        isMainWorktree: false,
        isRemote: false,
        isSparse: false,
        status: 'ok',
        error: null,
        sizeBytes: 200,
        reclaimableBytes: 200,
        canDelete: true,
        lastActivityAt: 0,
        scannedAt: 1,
        skippedEntryCount: 0,
        topLevelItems: [],
        omittedTopLevelItemCount: 0,
        omittedTopLevelSizeBytes: 0
      }
    ]
  }
}

describe('workspace space slice', () => {
  it('keeps streamed measurements across later progress updates', () => {
    const store = createWorkspaceSpaceTestStore()
    store.setState({ workspaceSpaceScanning: true })
    const progress = {
      scanId: 'scan-1',
      state: 'running' as const,
      startedAt: 1,
      updatedAt: 1,
      totalRepoCount: 1,
      scannedRepoCount: 0,
      totalWorktreeCount: 2,
      scannedWorktreeCount: 1,
      currentRepoDisplayName: 'orca',
      currentWorktreeDisplayName: 'feature'
    }

    store.getState().applyWorkspaceSpaceProgress({
      ...progress,
      completedMeasurements: [{ worktreeId: 'a', status: 'ok', sizeBytes: 10 }]
    })
    store.getState().applyWorkspaceSpaceProgress({
      ...progress,
      scannedWorktreeCount: 2,
      currentWorktreeDisplayName: null
    })

    expect(store.getState().workspaceSpaceMeasurements).toEqual([
      { worktreeId: 'a', status: 'ok', sizeBytes: 10 }
    ])
  })

  it('keeps state identity when removal matches no worktree', () => {
    const store = createWorkspaceSpaceTestStore()
    store.setState({ workspaceSpaceAnalysis: makeAnalysis() })
    const before = store.getState()

    store.getState().removeWorkspaceSpaceWorktrees(['repo-2::/elsewhere'])

    expect(store.getState()).toBe(before)
    expect(store.getState().workspaceSpaceAnalysis).toBe(before.workspaceSpaceAnalysis)
    expect(store.getState().workspaceSpaceMeasurements).toBe(before.workspaceSpaceMeasurements)
  })

  it('removes deleted worktrees from cached analysis totals', () => {
    const store = createWorkspaceSpaceTestStore()
    store.setState({ workspaceSpaceAnalysis: makeAnalysis() })

    store.getState().removeWorkspaceSpaceWorktrees(['repo-1::/repo/feature'])

    const analysis = store.getState().workspaceSpaceAnalysis
    expect(analysis?.worktreeCount).toBe(1)
    expect(analysis?.totalSizeBytes).toBe(100)
    expect(analysis?.reclaimableBytes).toBe(0)
    expect(analysis?.repos[0]).toMatchObject({
      worktreeCount: 1,
      scannedWorktreeCount: 1,
      totalSizeBytes: 100,
      reclaimableBytes: 0
    })
  })
})
