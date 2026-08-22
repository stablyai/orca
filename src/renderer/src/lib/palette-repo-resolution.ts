import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'

type PaletteWorktreeIdentity = Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>

export type PaletteWorktreeIndex<T extends PaletteWorktreeIdentity = Worktree> = {
  byHostIdentity: ReadonlyMap<string, T>
  byBareId: ReadonlyMap<string, T>
}

export function buildPaletteWorktreeIndex<T extends PaletteWorktreeIdentity>(
  worktrees: readonly T[]
): PaletteWorktreeIndex<T> {
  const byHostIdentity = new Map<string, T>()
  const byBareId = new Map<string, T>()
  for (const worktree of worktrees) {
    byHostIdentity.set(getWorktreeHostIdentity(worktree), worktree)
    if (worktree.runtimeOwnerEnvironmentId) {
      byHostIdentity.set(
        composeWorktreeHostIdentity(
          toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId),
          worktree.id
        ),
        worktree
      )
    }
    if (!byBareId.has(worktree.id)) {
      byBareId.set(worktree.id, worktree)
    }
  }
  return { byHostIdentity, byBareId }
}

export function resolvePaletteWorktree<T extends PaletteWorktreeIdentity>(
  index: PaletteWorktreeIndex<T>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): T | undefined {
  if (!executionHostId) {
    return index.byBareId.get(worktreeId)
  }
  return (
    index.byHostIdentity.get(composeWorktreeHostIdentity(executionHostId, worktreeId)) ??
    (executionHostId === LOCAL_EXECUTION_HOST_ID
      ? index.byHostIdentity.get(composeWorktreeHostIdentity(undefined, worktreeId))
      : undefined)
  )
}

/** Resolve the repo that owns a worktree, preserving host collisions. */
export function resolvePaletteRepoForWorktree<T extends { displayName?: string | null }>(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  repoMap: ReadonlyMap<string, T>,
  repoMapByHostIdentity?: ReadonlyMap<string, T>
): T | undefined {
  if (worktree.runtimeOwnerEnvironmentId) {
    return repoMapByHostIdentity?.get(
      getRepoHostIdentityForParts(
        worktree.repoId,
        toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
      )
    )
  }
  return (
    repoMapByHostIdentity?.get(
      getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
    ) ?? repoMap.get(worktree.repoId)
  )
}

export function isPaletteCurrentWorktree(
  worktree: Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  activeWorktreeId: string | null,
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
): boolean {
  if (activeWorkspaceExecutionHostId === undefined) {
    return activeWorktreeId === worktree.id
  }
  return (
    activeWorktreeId === worktree.id &&
    isExecutionHostAliasForWorktree(
      activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID,
      worktree
    )
  )
}
