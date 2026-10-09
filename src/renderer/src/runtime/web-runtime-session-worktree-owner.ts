import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  findWorktreeForSelectionOwner,
  worktreeSelectionOwnerForRow,
  worktreeSelectionOwnerKey,
  type WorktreeSelectionRow,
  type WorktreeSelectionRepo
} from '@/lib/worktree-selection-owner'
import {
  findIndexedWorktreesById,
  findIndexedDetectedWorktrees
} from '@/lib/worktree-runtime-owner-index'

export type WebRuntimeSessionOwnerState = {
  activeWorktreeId: string | null
  activeWorkspaceOwner?: WorktreeSelectionOwner | null
  repos?: readonly WorktreeSelectionRepo[]
  worktreesByRepo?: Record<string, readonly WorktreeSelectionRow[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorktreeSelectionRow[] }>
}

export function isCurrentWebRuntimeSessionWorktreeOwner(
  state: WebRuntimeSessionOwnerState,
  environmentId: string,
  owner: WorktreeSelectionOwner
): boolean {
  return (
    owner.publisherHostId === toRuntimeExecutionHostId(environmentId) &&
    findWorktreeForSelectionOwner(state, owner) !== null &&
    !(
      state.activeWorktreeId === owner.worktreeId &&
      state.activeWorkspaceOwner &&
      worktreeSelectionOwnerKey(state.activeWorkspaceOwner) !== worktreeSelectionOwnerKey(owner)
    )
  )
}

export function admitsWebRuntimeSessionWorktreeSnapshot(
  state: WebRuntimeSessionOwnerState | undefined,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  expected?: WorktreeSelectionOwner
): boolean {
  if (!state) {
    return expected === undefined
  }
  const identity = snapshot.worktreeIdentity
  if (
    state.activeWorktreeId === snapshot.worktree &&
    state.activeWorkspaceOwner &&
    state.activeWorkspaceOwner.publisherHostId !== toRuntimeExecutionHostId(environmentId)
  ) {
    return false
  }
  const owner = identity
    ? {
        worktreeId: snapshot.worktree,
        publisherHostId: toRuntimeExecutionHostId(environmentId),
        executionHostId: identity.executionHostId,
        instanceId: identity.instanceId
      }
    : expected
  if (
    expected &&
    (!isCurrentWebRuntimeSessionWorktreeOwner(state, environmentId, expected) ||
      snapshot.worktree !== expected.worktreeId ||
      (owner && worktreeSelectionOwnerKey(owner) !== worktreeSelectionOwnerKey(expected)))
  ) {
    return false
  }
  if (identity) {
    return (
      identity.key === canonicalWorktreeIdentity({ worktreeId: snapshot.worktree, ...identity }) &&
      owner !== undefined &&
      isCurrentWebRuntimeSessionWorktreeOwner(state, environmentId, owner)
    )
  }
  const owners = [
    ...findIndexedWorktreesById(state.worktreesByRepo, snapshot.worktree),
    ...findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, snapshot.worktree)
  ].flatMap((row) => {
    const captured = worktreeSelectionOwnerForRow(row, state.repos)
    return captured?.publisherHostId === toRuntimeExecutionHostId(environmentId) ? [captured] : []
  })
  const publishers = new Set(owners.map(worktreeSelectionOwnerKey))
  return publishers.size === 0
    ? expected === undefined
    : publishers.size === 1 &&
        owners[0] !== undefined &&
        findWorktreeForSelectionOwner(state, owners[0]) !== null
}
