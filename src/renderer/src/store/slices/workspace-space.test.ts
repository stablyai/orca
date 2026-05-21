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
    packageManagerCaches: [
      {
        id: 'local:pnpm:%2Frepo%2Fmain',
        packageManager: 'pnpm',
        connectionId: null,
        isRemote: false,
        targetLabel: 'pnpm on this computer',
        cwd: '/repo/main',
        cachePath: null,
        detectedWorktreeCount: 2,
        detectedWorktrees: [
          { worktreeId: 'repo-1::/repo/main', lockfiles: ['pnpm-lock.yaml'] },
          { worktreeId: 'repo-1::/repo/feature', lockfiles: ['pnpm-lock.yaml'] }
        ],
        detectedLockfiles: ['pnpm-lock.yaml'],
        cliAvailable: true,
        unavailableReason: null,
        cleanupActions: []
      },
      {
        id: 'local:npm:%2Frepo%2Ffeature',
        packageManager: 'npm',
        connectionId: null,
        isRemote: false,
        targetLabel: 'npm on this computer',
        cwd: '/repo/feature',
        cachePath: null,
        detectedWorktreeCount: 1,
        detectedWorktrees: [
          { worktreeId: 'repo-1::/repo/feature', lockfiles: ['package-lock.json'] }
        ],
        detectedLockfiles: ['package-lock.json'],
        cliAvailable: true,
        unavailableReason: null,
        cleanupActions: []
      }
    ],
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
  it('removes stale package-manager cache detections when workspaces are removed', () => {
    const store = createWorkspaceSpaceTestStore()
    store.setState({ workspaceSpaceAnalysis: makeAnalysis() })

    store.getState().removeWorkspaceSpaceWorktrees(['repo-1::/repo/feature'])

    const analysis = store.getState().workspaceSpaceAnalysis
    expect(analysis?.worktreeCount).toBe(1)
    expect(analysis?.packageManagerCaches).toEqual([
      expect.objectContaining({
        id: 'local:pnpm:%2Frepo%2Fmain',
        cwd: '/repo/main',
        detectedWorktreeCount: 1,
        detectedWorktrees: [{ worktreeId: 'repo-1::/repo/main', lockfiles: ['pnpm-lock.yaml'] }],
        detectedLockfiles: ['pnpm-lock.yaml']
      })
    ])
  })

  it('moves a package-manager cleanup target to a surviving cwd', () => {
    const store = createWorkspaceSpaceTestStore()
    store.setState({ workspaceSpaceAnalysis: makeAnalysis() })

    store.getState().removeWorkspaceSpaceWorktrees(['repo-1::/repo/main'])

    const analysis = store.getState().workspaceSpaceAnalysis
    expect(analysis?.packageManagerCaches).toEqual([
      expect.objectContaining({
        id: 'local:pnpm:%2Frepo%2Ffeature',
        cwd: '/repo/feature',
        detectedWorktreeCount: 1,
        detectedWorktrees: [{ worktreeId: 'repo-1::/repo/feature', lockfiles: ['pnpm-lock.yaml'] }]
      }),
      expect.objectContaining({
        id: 'local:npm:%2Frepo%2Ffeature',
        cwd: '/repo/feature',
        detectedWorktreeCount: 1,
        detectedWorktrees: [
          { worktreeId: 'repo-1::/repo/feature', lockfiles: ['package-lock.json'] }
        ]
      })
    ])
  })
})
