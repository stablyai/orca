import type { GitStatusResult } from '../../../../shared/git-status-types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import type { WorkspaceSpaceDeleteState } from './workspace-space-manager-state-types'

const EMPTY_GIT_STATUS_BY_WORKTREE_IDENTITY = new Map<string, GitStatusResult['entries']>()

/** Keep status results tied to the scan that requested them. */
export function getWorkspaceSpaceGitStatusForScan(
  cachedScanGeneration: number | null,
  currentScanGeneration: number | null,
  cachedStatus: ReadonlyMap<string, GitStatusResult['entries']>
): ReadonlyMap<string, GitStatusResult['entries']> {
  return cachedScanGeneration === currentScanGeneration
    ? cachedStatus
    : EMPTY_GIT_STATUS_BY_WORKTREE_IDENTITY
}

/** Resolve a delete state without leaking another host's same-id row. */
export function getWorkspaceSpaceDeleteState(
  worktree: Pick<WorkspaceSpaceWorktree, 'worktreeId' | 'executionHostId'>,
  deleteStateByWorktreeId: Readonly<Record<string, WorkspaceSpaceDeleteState | undefined>>,
  hasSameIdSibling: boolean
): WorkspaceSpaceDeleteState | undefined {
  const qualifiedState = deleteStateByWorktreeId[getWorkspaceSpaceWorktreeIdentity(worktree)]
  if (qualifiedState) {
    return qualifiedState
  }
  const legacyState = deleteStateByWorktreeId[worktree.worktreeId]
  if (!hasSameIdSibling || !legacyState) {
    return legacyState
  }
  return legacyState.executionHostId !== undefined &&
    legacyState.executionHostId === worktree.executionHostId
    ? legacyState
    : undefined
}
