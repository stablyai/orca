import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { executionHostIdForSessionTabsOwner } from './local-structured-session-owner'
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
    owner.publisherHostId === executionHostIdForSessionTabsOwner(environmentId) &&
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
    state.activeWorkspaceOwner.publisherHostId !== executionHostIdForSessionTabsOwner(environmentId)
  ) {
    return false
  }
  const owner = identity
    ? {
        worktreeId: snapshot.worktree,
        publisherHostId: executionHostIdForSessionTabsOwner(environmentId),
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
  const rows = [
    ...findIndexedWorktreesById(state.worktreesByRepo, snapshot.worktree),
    ...findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, snapshot.worktree)
  ]
  if (rows.length === 0) {
    return expected === undefined
  }
  const owners: WorktreeSelectionOwner[] = []
  for (const row of rows) {
    const captured = worktreeSelectionOwnerForRow(row, state.repos)
    if (!captured) {
      return false
    }
    if (captured.publisherHostId === executionHostIdForSessionTabsOwner(environmentId)) {
      owners.push(captured)
    }
  }
  const publishers = new Set(owners.map(worktreeSelectionOwnerKey))
  return (
    publishers.size === 1 &&
    owners[0] !== undefined &&
    findWorktreeForSelectionOwner(state, owners[0]) !== null
  )
}
