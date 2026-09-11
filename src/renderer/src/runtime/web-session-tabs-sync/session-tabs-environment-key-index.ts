import {
  lastHostTerminalTabCountByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRecoveryStateByWorktree
} from './state'

/**
 * Reverse index from an environment to the worktrees it has minted per-worktree
 * keys for. Environment teardown runs once per environment on every pairing
 * revision change, so scanning every key of every per-worktree map made that
 * cost quadratic in the environment count. Mirrors the shape already used by
 * `hostSessionTabMappingKeysByEnvironmentAndWorktree`.
 */
const keyedWorktreeIdsByEnvironment = new Map<string, Set<string>>()

export function noteSessionTabsEnvironmentKeyedWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const worktreeIds = keyedWorktreeIdsByEnvironment.get(environmentId)
  if (worktreeIds) {
    worktreeIds.add(worktreeId)
    return
  }
  keyedWorktreeIdsByEnvironment.set(environmentId, new Set([worktreeId]))
}

/** Snapshot so callers may delete index entries while iterating. */
export function getSessionTabsEnvironmentKeyedWorktrees(environmentId: string): string[] {
  return [...(keyedWorktreeIdsByEnvironment.get(environmentId) ?? [])]
}

/** Drops the index entry once the last per-worktree map has released the key. */
export function releaseSessionTabsEnvironmentKeyedWorktree(
  environmentId: string,
  worktreeId: string,
  key: string
): void {
  if (
    latestSessionTabsSnapshotByWorktree.has(key) ||
    replayableSessionTabsSnapshotByWorktree.has(key) ||
    latestReceivedSessionTabsSnapshotByWorktree.has(key) ||
    sessionTabsPublicationEpochHistoryByWorktree.has(key) ||
    latestSessionTabsRemovalFenceByWorktree.has(key) ||
    sessionTabsRecoveryStateByWorktree.has(key) ||
    lastHostTerminalTabCountByWorktree.has(key) ||
    sessionTabsInventoryOmissionsByWorktree.has(key)
  ) {
    return
  }
  const worktreeIds = keyedWorktreeIdsByEnvironment.get(environmentId)
  if (!worktreeIds) {
    return
  }
  worktreeIds.delete(worktreeId)
  if (worktreeIds.size === 0) {
    keyedWorktreeIdsByEnvironment.delete(environmentId)
  }
}

export function dropSessionTabsEnvironmentKeyIndex(environmentId: string): void {
  keyedWorktreeIdsByEnvironment.delete(environmentId)
}

export function clearSessionTabsEnvironmentKeyIndex(): void {
  keyedWorktreeIdsByEnvironment.clear()
}

export function _getSessionTabsEnvironmentKeyIndexCountsForTest(): {
  environments: number
  worktrees: number
} {
  let worktrees = 0
  for (const worktreeIds of keyedWorktreeIdsByEnvironment.values()) {
    worktrees += worktreeIds.size
  }
  return { environments: keyedWorktreeIdsByEnvironment.size, worktrees }
}
