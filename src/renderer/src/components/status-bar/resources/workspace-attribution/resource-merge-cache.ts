/** Keeps unchanged chat-only rows and their project groups across merges, per host sample and workspace. */

import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type { UnifiedProjectGroup, UnifiedWorktreeRow } from './resource-usage-merge-types'

export type ResourceMergeCache = {
  rowsBySample: WeakMap<WorktreeMemory, UnifiedWorktreeRow>
  groupsByRepoId: Map<string, UnifiedProjectGroup>
}

export function createResourceMergeCache(): ResourceMergeCache {
  return { rowsBySample: new WeakMap(), groupsByRepoId: new Map() }
}

type RowPlacement = Pick<
  UnifiedWorktreeRow,
  | 'worktreeId'
  | 'worktreeName'
  | 'repoId'
  | 'repoName'
  | 'isRemote'
  | 'hostLabel'
  | 'runtimeHostId'
  | 'unplaced'
>

export function cachedSampleRow(
  cache: ResourceMergeCache | undefined,
  wt: WorktreeMemory,
  placement: RowPlacement
): UnifiedWorktreeRow | undefined {
  // Terminal rows depend on tab bindings and titles, so only rows without sessions are kept.
  if (!cache || wt.sessions.length > 0) {
    return undefined
  }
  const row = cache.rowsBySample.get(wt)
  return row &&
    row.worktreeId === placement.worktreeId &&
    row.worktreeName === placement.worktreeName &&
    row.repoId === placement.repoId &&
    row.repoName === placement.repoName &&
    row.isRemote === placement.isRemote &&
    row.hostLabel === placement.hostLabel &&
    row.runtimeHostId === placement.runtimeHostId &&
    row.unplaced === placement.unplaced
    ? row
    : undefined
}

export function rememberSampleRow(
  cache: ResourceMergeCache | undefined,
  wt: WorktreeMemory,
  row: UnifiedWorktreeRow
): void {
  if (cache && wt.sessions.length === 0) {
    cache.rowsBySample.set(wt, row)
  }
}

/** Returns the previous group when it holds the same rows, so its sorted copy can be reused. */
export function reuseUnchangedGroups(
  cache: ResourceMergeCache | undefined,
  groups: UnifiedProjectGroup[]
): UnifiedProjectGroup[] {
  if (!cache) {
    return groups
  }
  const previous = cache.groupsByRepoId
  const next = new Map<string, UnifiedProjectGroup>()
  const result = groups.map((group) => {
    const prior = previous.get(group.repoId)
    const kept = prior && sameGroup(prior, group) ? prior : group
    next.set(group.repoId, kept)
    return kept
  })
  cache.groupsByRepoId = next
  return result
}

function sameGroup(a: UnifiedProjectGroup, b: UnifiedProjectGroup): boolean {
  if (
    a.repoName !== b.repoName ||
    a.hasRemoteChildren !== b.hasRemoteChildren ||
    a.worktrees.length !== b.worktrees.length
  ) {
    return false
  }
  for (let i = 0; i < a.worktrees.length; i++) {
    if (a.worktrees[i] !== b.worktrees[i]) {
      return false
    }
  }
  return true
}
