import { describe, expect, it } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import {
  filterWorkspaceSpaceRows,
  getSelectedDeletableWorkspaceIds,
  getVisibleDeletableWorkspaceIds,
  sortWorkspaceSpaceRows
} from './workspace-space-presentation'

function row(overrides: Partial<WorkspaceSpaceWorktree>): WorkspaceSpaceWorktree {
  return {
    worktreeId: 'wt',
    repoId: 'repo',
    repoDisplayName: 'repo',
    repoPath: '/repo',
    displayName: 'workspace',
    path: '/workspace',
    branch: 'refs/heads/main',
    isMainWorktree: false,
    isRemote: false,
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 0,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0,
    ...overrides
  }
}

describe('workspace space presentation helpers', () => {
  it('sorts rows by the selected key and direction', () => {
    const rows = [
      row({ worktreeId: 'small', displayName: 'Small', sizeBytes: 10 }),
      row({ worktreeId: 'large', displayName: 'Large', sizeBytes: 100 }),
      row({ worktreeId: 'mid', displayName: 'Mid', sizeBytes: 50 })
    ]

    expect(sortWorkspaceSpaceRows(rows, 'size', 'desc').map((item) => item.worktreeId)).toEqual([
      'large',
      'mid',
      'small'
    ])
    expect(sortWorkspaceSpaceRows(rows, 'name', 'asc').map((item) => item.worktreeId)).toEqual([
      'large',
      'mid',
      'small'
    ])
  })

  it('filters by search text and deletable status', () => {
    const rows = [
      row({ worktreeId: 'a', displayName: 'Frontend Cache', repoDisplayName: 'app' }),
      row({ worktreeId: 'b', displayName: 'Main', repoDisplayName: 'api', canDelete: false })
    ]

    expect(filterWorkspaceSpaceRows(rows, 'cache', false).map((item) => item.worktreeId)).toEqual([
      'a'
    ])
    expect(filterWorkspaceSpaceRows(rows, '', true).map((item) => item.worktreeId)).toEqual(['a'])
  })

  it('returns only selected worktrees that can be deleted', () => {
    const rows = [
      row({ worktreeId: 'ok', canDelete: true, status: 'ok' }),
      row({ worktreeId: 'main', canDelete: false, status: 'ok' }),
      row({ worktreeId: 'failed', canDelete: true, status: 'error' })
    ]

    expect(getSelectedDeletableWorkspaceIds(rows, new Set(['ok', 'main', 'failed']))).toEqual([
      'ok'
    ])
  })

  it('excludes rows that are already deleting from delete actions', () => {
    const rows = [
      row({ worktreeId: 'idle', canDelete: true, status: 'ok' }),
      row({ worktreeId: 'deleting', canDelete: true, status: 'ok' })
    ]
    const isDeleting = (worktreeId: string): boolean => worktreeId === 'deleting'

    expect(getVisibleDeletableWorkspaceIds(rows, isDeleting)).toEqual(['idle'])
    expect(
      getSelectedDeletableWorkspaceIds(rows, new Set(['idle', 'deleting']), isDeleting)
    ).toEqual(['idle'])
  })
})
