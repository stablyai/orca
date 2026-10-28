import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../shared/worktree-execution-host-resolution'
import { workspaceIdsNamedByPartition } from '../../../shared/workspace-session-stranded-partition-adoption'

/** Contested SSH adoption may gap-fill, never replace: evidence is prior local/runtime rivalry, duplicate SSH partitions, or catalog multi-host repo IDs. Mere local/ssh co-presence is the repair’s input, not collision proof. Foreign means positive catalog reattribution; unknown catalogs prove neither, so unhydrated boot still reunites rows. */
export function sshPartitionCatalogAttribution(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  sshPartitions: readonly (readonly [ExecutionHostId, WorkspaceSessionState | null])[],
  mergedContested: ReadonlySet<string>,
  managedServerWorkspaces: ReadonlyMap<ExecutionHostId, ReadonlySet<string>>
) {
  const contestedSessionKeys = new Set(mergedContested)
  const foreignSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const ownedSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const repoLookup = createRepoRowExecutionHostLookup(repos)
  const ownedByHostId = new Map<ExecutionHostId, Set<string>>()
  for (const [hostId, slice] of sshPartitions) {
    if (!slice) {
      continue
    }
    const foreign = new Set<string>()
    const owned = new Set<string>()
    const catalogOwned = new Set<string>()
    for (const workspaceId of workspaceIdsNamedByPartition(slice)) {
      // Folder keys have no repo; skip resolver work that would only answer unknown for folder:<uuid>.
      const resolution = isWorktreeSessionKey(workspaceId)
        ? resolveWorktreeExecutionHost(repoLookup, {
            repoId: getRepoIdFromWorktreeId(workspaceId),
            hostId: null
          })
        : null
      if (
        managedServerWorkspaces.get(hostId)?.has(workspaceId) ||
        (resolution?.kind === 'resolved' && resolution.hostId !== hostId)
      ) {
        foreign.add(workspaceId)
        continue
      }
      if (resolution?.kind === 'resolved') {
        catalogOwned.add(workspaceId)
      } else if (resolution?.reason === 'ambiguous') {
        contestedSessionKeys.add(workspaceId)
      }
      owned.add(workspaceId)
    }
    if (foreign.size > 0) {
      foreignSessionKeysByHostId.set(hostId, foreign)
    }
    ownedByHostId.set(hostId, owned)
    ownedSessionKeysByHostId.set(hostId, catalogOwned)
  }
  // Check co-presence after catalog attribution: foreign residue is not a rival and must not withhold the real owner’s rows.
  for (const workspaceId of sessionKeysHeldByMultiplePartitionSets([...ownedByHostId.values()])) {
    contestedSessionKeys.add(workspaceId)
  }
  return { contestedSessionKeys, foreignSessionKeysByHostId, ownedSessionKeysByHostId }
}

/** Workspaces each SSH host's own server partition holds. That server succeeded the SSH host, so SSH rows for them are residue from before it, not a legacy local/SSH split (#34376, #34416). */
export function workspacesHeldByManagedServers(
  slices: Readonly<Partial<Record<ExecutionHostId, WorkspaceSessionState>>>,
  sshHostIdByRuntimeHostId: ReadonlyMap<ExecutionHostId, ExecutionHostId>
): Map<ExecutionHostId, Set<string>> {
  const held = new Map<ExecutionHostId, Set<string>>()
  for (const [runtimeHostId, sshHostId] of sshHostIdByRuntimeHostId) {
    const slice = slices[runtimeHostId]
    if (slice) {
      const keys = held.get(sshHostId) ?? new Set<string>()
      for (const workspaceId of workspaceIdsNamedByPartition(slice)) {
        keys.add(workspaceId)
      }
      held.set(sshHostId, keys)
    }
  }
  return held
}

function sessionKeysHeldByMultiplePartitionSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  const held = new Set<string>()
  const contested = new Set<string>()
  for (const keys of sets) {
    for (const key of keys) {
      if (held.has(key)) {
        contested.add(key)
      }
      held.add(key)
    }
  }
  return contested
}

/** A worktree session key names its repo before `::`; a folder key names no repo at all. */
function isWorktreeSessionKey(workspaceId: string): boolean {
  return workspaceId.includes('::')
}
