import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { AUTHORITATIVE_REMOVAL_MEMORY_LIMIT } from './worktree-slice-constants'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type RemovedWorktreeInstance = Pick<Worktree, 'id' | 'instanceId'>

// Bridge async durable SSH-metadata deletion with session suppression; reloads rely on actual metadata retirement.
const authoritativelyRemovedWorktreeIdsByHost = new Map<ExecutionHostId, Set<string>>()
const removedInstanceIdsByHost = new Map<ExecutionHostId, Map<string, string | null>>()

type AuthoritativeWorktreeRemovalListener = (
  hostId: ExecutionHostId,
  worktrees: readonly RemovedWorktreeInstance[]
) => void
const removalListeners = new Set<AuthoritativeWorktreeRemovalListener>()

/** Hears every proven removal, including ones this bounded memory never keeps or has since evicted. */
export function subscribeToAuthoritativeWorktreeRemovals(
  listener: AuthoritativeWorktreeRemovalListener
): () => void {
  removalListeners.add(listener)
  return () => removalListeners.delete(listener)
}

/** Reports a proven removal without fencing listings; hosts whose reads cannot resurrect rows use this. */
export function announceAuthoritativeWorktreeRemovals(
  hostId: ExecutionHostId,
  worktrees: readonly RemovedWorktreeInstance[]
): void {
  if (worktrees.length === 0) {
    return
  }
  for (const listener of removalListeners) {
    listener(hostId, worktrees)
  }
}

export function rememberAuthoritativelyRemovedWorktrees(
  hostId: ExecutionHostId,
  worktreeIds: readonly string[],
  worktrees: readonly RemovedWorktreeInstance[] = worktreeIds.map((id) => ({ id }))
): void {
  if (worktreeIds.length === 0) {
    return
  }
  announceAuthoritativeWorktreeRemovals(hostId, worktrees)
  const removed = authoritativelyRemovedWorktreeIdsByHost.get(hostId) ?? new Set<string>()
  const instances = removedInstanceIdsByHost.get(hostId) ?? new Map<string, string | null>()
  const incomingInstances = new Map(worktrees.map(({ id, instanceId }) => [id, instanceId ?? null]))
  for (const worktreeId of worktreeIds) {
    // Why: re-insert so a re-removed id moves to the back of the insertion order the cap evicts from.
    removed.delete(worktreeId)
    removed.add(worktreeId)
    instances.set(worktreeId, incomingInstances.get(worktreeId) ?? null)
  }
  for (const oldest of removed) {
    if (removed.size <= AUTHORITATIVE_REMOVAL_MEMORY_LIMIT) {
      break
    }
    removed.delete(oldest)
    instances.delete(oldest)
  }
  authoritativelyRemovedWorktreeIdsByHost.set(hostId, removed)
  removedInstanceIdsByHost.set(hostId, instances)
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
    removedInstanceIdsByHost.get(hostId)?.delete(worktreeId)
  }
  if (removed.size === 0) {
    authoritativelyRemovedWorktreeIdsByHost.delete(hostId)
    removedInstanceIdsByHost.delete(hostId)
  }
}

/** Test-only: module-level removal memory would otherwise leak across cases in one file. */
export function resetAuthoritativelyRemovedWorktreeMemoryForTests(): void {
  authoritativelyRemovedWorktreeIdsByHost.clear()
  removedInstanceIdsByHost.clear()
}

export function isWorktreeInstanceAuthoritativelyRemoved(
  hostId: ExecutionHostId,
  worktree: RemovedWorktreeInstance
): boolean {
  return removedInstanceIdsByHost.get(hostId)?.get(worktree.id) === (worktree.instanceId ?? null)
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
