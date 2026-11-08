import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { findKnownWorktreeById } from '../../slices/worktrees/listing/detected-worktree-meta'
import { getSelectedFolderTwinHostId } from '../../../lib/folder-workspace-runtime-owner'

type WorktreeLookupHostState = Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>

// Why: worktree ids repeat across hosts, so the active id must resolve on the host the user selected.
function getWorktreeLookupHostId(
  state: WorktreeLookupHostState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  return (
    executionHostId ??
    (worktreeId === state.activeWorktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined)
  )
}

/** Catalog row (including folder and floating workspaces) read from this snapshot. */
export function selectKnownWorktreeById(
  state: WorktreeLookupHostState & Parameters<typeof findKnownWorktreeById>[0],
  worktreeId: string | null,
  executionHostId?: ExecutionHostId
): NonNullable<ReturnType<typeof findKnownWorktreeById>> | null {
  return worktreeId
    ? (findKnownWorktreeById(
        state,
        worktreeId,
        getWorktreeLookupHostId(state, worktreeId, executionHostId)
      ) ?? null)
    : null
}

/** File lists keep host-less git ownership; a folder twin resolves on the copy the user selected. */
export function selectFileListWorktree(
  state: WorktreeLookupHostState & Parameters<typeof findKnownWorktreeById>[0],
  worktreeId: string | null
): NonNullable<ReturnType<typeof findKnownWorktreeById>> | null {
  return worktreeId
    ? (findKnownWorktreeById(state, worktreeId, getSelectedFolderTwinHostId(state, worktreeId)) ??
        null)
    : null
}
