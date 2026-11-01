import { describe, expect, it } from 'vitest'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import { selectSpaceWindowAnalysis } from './space-window-state'

function worktree(topLevelItems: WorkspaceSpaceWorktree['topLevelItems']): WorkspaceSpaceWorktree {
  return {
    worktreeId: 'wt',
    repoId: 'repo',
    repoDisplayName: 'repo',
    repoPath: '/repo',
    displayName: 'workspace',
    path: '/workspace',
    branch: 'main',
    isMainWorktree: false,
    isRemote: false,
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 1,
    sizeBytes: 1,
    reclaimableBytes: 1,
    skippedEntryCount: 0,
    topLevelItems,
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

function analysis(rows: WorkspaceSpaceWorktree[], scannedAt = 1): WorkspaceSpaceAnalysis {
  return {
    scannedAt,
    totalSizeBytes: rows.length,
    reclaimableBytes: rows.length,
    worktreeCount: rows.length,
    scannedWorktreeCount: rows.length,
    unavailableWorktreeCount: 0,
    repos: [],
    worktrees: rows
  }
}

describe('selectSpaceWindowAnalysis', () => {
  it('restores live folder details over the persisted summary for the same scan', () => {
    const cached = analysis([worktree([])])
    const live = analysis([
      worktree([{ name: 'src', path: '/workspace/src', kind: 'directory', sizeBytes: 1 }])
    ])

    expect(selectSpaceWindowAnalysis(cached, live)).toBe(live)
    expect(selectSpaceWindowAnalysis(live, cached)).toBe(live)
  })

  it('keeps a same-scan deletion and prefers a newer scan', () => {
    const beforeDelete = analysis([worktree([])])
    const afterDelete = analysis([])
    const refreshed = analysis([worktree([])], 2)

    expect(selectSpaceWindowAnalysis(afterDelete, beforeDelete)).toBe(afterDelete)
    expect(selectSpaceWindowAnalysis(beforeDelete, afterDelete)).toBe(afterDelete)
    expect(selectSpaceWindowAnalysis(afterDelete, refreshed)).toBe(refreshed)
  })
})
