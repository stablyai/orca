import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { workspacePublishingHosts } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { collectPtyIdsForTab } from '../slices/terminal-tab-retirement'
import type { AppState } from '../types'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const removalsByStore = new WeakMap<
  () => AppState,
  Set<{ repoId: string; hostId: ExecutionHostId; deferred: Map<string, HostWorktreeTarget> }>
>()

// Adapted from #23249: an explicit removal retains tab/PTY mappings through its host await.
export function beginRepoCatalogRemoval(
  get: () => AppState,
  repoId: string,
  hostId: ExecutionHostId
): () => HostWorktreeTarget[] {
  const removals = removalsByStore.get(get) ?? new Set()
  removalsByStore.set(get, removals)
  const removal = { repoId, hostId, deferred: new Map<string, HostWorktreeTarget>() }
  removals.add(removal)
  return () => {
    removals.delete(removal)
    return [...removal.deferred.values()]
  }
}

export function isRepoCatalogRemovalInFlight(
  get: () => AppState,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  return [...(removalsByStore.get(get) ?? [])].some(
    (removal) => removal.repoId === repoId && removal.hostId === hostId
  )
}

export function deferInFlightRepoCatalogPurge(
  get: () => AppState,
  target: HostWorktreeTarget
): boolean {
  const owners = [...(removalsByStore.get(get) ?? [])].filter(
    (removal) =>
      removal.repoId === getRepoIdFromWorktreeId(target.id) && removal.hostId === target.hostId
  )
  for (const owner of owners) {
    owner.deferred.set(target.id, target)
  }
  return owners.length > 0
}

export function deferredRepoCatalogPurgeTargets(
  get: () => AppState,
  repoId: string,
  hostId: ExecutionHostId
): HostWorktreeTarget[] {
  return [...(removalsByStore.get(get) ?? [])].flatMap((removal) =>
    removal.repoId === repoId && removal.hostId === hostId ? [...removal.deferred.values()] : []
  )
}

export function settleDeferredRepoCatalogRemoval(
  get: () => AppState,
  deferred: readonly HostWorktreeTarget[],
  removalSucceeded: boolean,
  hostId: ExecutionHostId
): void {
  if (deferred.length === 0) {
    return
  }
  if (!removalSucceeded && hostId === LOCAL_EXECUTION_HOST_ID) {
    const killed = new Set<string>()
    for (const target of deferred) {
      if (workspacePublishingHosts(get(), target.id).some((host) => host !== target.hostId)) {
        continue
      }
      for (const tab of get().tabsByWorktree[target.id] ?? []) {
        for (const ptyId of collectPtyIdsForTab(get(), tab.id, tab.ptyId)) {
          if (!isRemoteRuntimePtyId(ptyId) && !killed.has(ptyId)) {
            killed.add(ptyId)
            window.api.pty.kill(ptyId)
          }
        }
      }
    }
  }
  get().purgeWorktreeTerminalState(deferred)
}
