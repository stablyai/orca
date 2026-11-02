import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'
import { CLEARED_HOSTED_REVIEW_LINK_UPDATES } from '../../../../../../shared/worktree/hosted-review-links'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'

// Why this module: worktree ids repeat across hosts (`repoId::path`), so branch-switch review
// clears are keyed by id plus the copy's owner and never by the bare id.

/**
 * One copy's owner: its host plus the paired server that published it (two can share an `ssh:` id).
 * Listing paths must stamp rows (`withRepoHostOwnership`) before comparing this key.
 */
export function worktreeCopyOwnerKey(
  row: Partial<Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>>
): string {
  // Why local folds into unstamped: discovery backfills `hostId: 'local'` on the same checkout.
  const hostId = row.hostId === LOCAL_EXECUTION_HOST_ID ? undefined : row.hostId
  // A `runtime:` host is its own server, so backfilled provenance must not change the key.
  if (parseExecutionHostId(hostId)?.kind === 'runtime') {
    return `${hostId}\0`
  }
  return `${hostId ?? ''}\0${row.runtimeOwnerEnvironmentId ?? ''}`
}

/** The copy a review clear is for. */
export type WorktreeCopyClear = {
  /** The owner key of the row once stamped; tombstones use it. */
  owner: string
  /** The row's own key at clear time, which differs only while a legacy row is unstamped. */
  rowOwner: string
  hostId: ExecutionHostId | undefined
}

/** Clears branch-scoped review context on the one copy `copy` names, stamped or not. */
export function clearCopyReviewLinks(
  byRepo: Record<string, Worktree[]>,
  worktreeId: string,
  copy: Pick<WorktreeCopyClear, 'owner' | 'rowOwner'>
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  let changed = false
  const next = byRepo[repoId]?.map((row) => {
    const rowOwner = worktreeCopyOwnerKey(row)
    if (row.id !== worktreeId || (rowOwner !== copy.owner && rowOwner !== copy.rowOwner)) {
      return row
    }
    changed = true
    return {
      ...row,
      ...normalizeWorkspaceAttachmentUpdate(row, CLEARED_HOSTED_REVIEW_LINK_UPDATES)
    }
  })
  return changed && next ? { ...byRepo, [repoId]: next } : byRepo
}

export function reviewClearTombstoneKey(worktreeId: string, owner: string): string {
  return `${worktreeId}\0${owner}`
}

/** Drops every copy's tombstone for `worktreeId`. */
export function deleteCopyTombstones(tombstones: Map<string, unknown>, worktreeId: string): void {
  for (const key of Array.from(tombstones.keys())) {
    if (key === worktreeId || key.startsWith(`${worktreeId}\0`)) {
      tombstones.delete(key)
    }
  }
}

/** Re-keys every copy's tombstone after a rename; true when any moved. */
export function moveCopyTombstones<T>(
  tombstones: Map<string, T>,
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  const prefix = `${oldWorktreeId}\0`
  let moved = false
  for (const [key, tombstone] of Array.from(tombstones)) {
    if (key.startsWith(prefix)) {
      tombstones.set(`${newWorktreeId}\0${key.slice(prefix.length)}`, tombstone)
      tombstones.delete(key)
      moved = true
    }
  }
  return moved
}

/**
 * A relink of one copy: drops that copy's tombstone (matched stamped or not) and moves the
 * siblings' guards to `generation` so they stay live. True when a sibling is still guarded.
 */
export function dropCopyTombstone<
  T extends { owner: string; rowOwner: string; generation: number }
>(tombstones: Map<string, T>, worktreeId: string, owner: string, generation: number): boolean {
  let siblingGuarded = false
  for (const [key, tombstone] of Array.from(tombstones)) {
    if (!key.startsWith(`${worktreeId}\0`)) {
      continue
    }
    if (tombstone.owner === owner || tombstone.rowOwner === owner) {
      tombstones.delete(key)
    } else {
      tombstones.set(key, { ...tombstone, generation })
      siblingGuarded = true
    }
  }
  return siblingGuarded
}
