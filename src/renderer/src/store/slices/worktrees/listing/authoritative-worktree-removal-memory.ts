import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { AUTHORITATIVE_REMOVAL_MEMORY_LIMIT } from './worktree-slice-constants'

// Bridge async durable SSH-metadata deletion with session suppression; reloads rely on actual metadata retirement.
const authoritativelyRemovedWorktreeIdsByHost = new Map<ExecutionHostId, Set<string>>()

export function rememberAuthoritativelyRemovedWorktrees(
  hostId: ExecutionHostId,
  worktreeIds: readonly string[]
): void {
  if (worktreeIds.length === 0) {
    return
  }
  const removed = authoritativelyRemovedWorktreeIdsByHost.get(hostId) ?? new Set<string>()
  for (const worktreeId of worktreeIds) {
    // Why: re-insert so a re-removed id moves to the back of the insertion order the cap evicts from.
    removed.delete(worktreeId)
    removed.add(worktreeId)
  }
  for (const oldest of removed) {
    if (removed.size <= AUTHORITATIVE_REMOVAL_MEMORY_LIMIT) {
      break
    }
    removed.delete(oldest)
  }
  authoritativelyRemovedWorktreeIdsByHost.set(hostId, removed)
}

// Why: a remote path can be recreated, so a scan that reports it again retracts the deletion verdict.
export function forgetAuthoritativelyRemovedWorktrees(
  hostId: ExecutionHostId,
  worktreeIds: Iterable<string>
): void {
  const removed = authoritativelyRemovedWorktreeIdsByHost.get(hostId)
  if (!removed) {
    return
  }
  for (const worktreeId of worktreeIds) {
    removed.delete(worktreeId)
  }
  if (removed.size === 0) {
    authoritativelyRemovedWorktreeIdsByHost.delete(hostId)
  }
}

/** Test-only: module-level removal memory would otherwise leak across cases in one file. */
export function resetAuthoritativelyRemovedWorktreeMemoryForTests(): void {
  authoritativelyRemovedWorktreeIdsByHost.clear()
}

// Off-host metadata bypasses local GC; retire scan-proven removals durably or fallback resurrects them after reload. Include runtimes, formerly excluded (#17776).
export function forgetPersistedWorktreeMetaForRemovals(
  repoId: string,
  hostId: ExecutionHostId,
  worktreeIds: readonly string[]
): void {
  const parsedHost = parseExecutionHostId(hostId)
  if (worktreeIds.length === 0 || (parsedHost?.kind !== 'ssh' && parsedHost?.kind !== 'runtime')) {
    return
  }
  const forget = window.api.worktrees.forgetRemovedForExecutionHost
  if (typeof forget !== 'function') {
    return
  }
  void forget({ repoId, executionHostId: parsedHost.id, worktreeIds: [...worktreeIds] }).catch(
    (err) => {
      console.warn(`Failed to forget metadata for removed worktrees in repo ${repoId}:`, err)
    }
  )
}

export function getAuthoritativelyRemovedWorktreeIds(
  hostId: ExecutionHostId
): Set<string> | undefined {
  return authoritativelyRemovedWorktreeIdsByHost.get(hostId)
}
