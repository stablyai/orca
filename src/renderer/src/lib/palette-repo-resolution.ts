import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'

type PaletteWorktreeIdentity = Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>

export function getPaletteWorktreeExecutionHostId(
  worktree: PaletteWorktreeIdentity
): ExecutionHostId | undefined {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  return runtimeOwner ? toRuntimeExecutionHostId(runtimeOwner) : worktree.hostId
}

export function getPaletteWorktreeIdentity(worktree: PaletteWorktreeIdentity): string {
  return composeWorktreeHostIdentity(getPaletteWorktreeExecutionHostId(worktree), worktree.id)
}

export type PaletteWorktreeIndex<T extends PaletteWorktreeIdentity = Worktree> = {
  byHostIdentity: ReadonlyMap<string, T>
  byBareId: ReadonlyMap<string, T>
}

export function dedupePaletteWorktrees<T extends PaletteWorktreeIdentity>(
  worktrees: readonly T[]
): T[] {
  const byIdentity = new Map<string, T>()
  for (const worktree of worktrees) {
    byIdentity.set(getPaletteWorktreeIdentity(worktree), worktree)
  }
  return [...byIdentity.values()]
}

export function buildPaletteWorktreeIndex<T extends PaletteWorktreeIdentity>(
  worktrees: readonly T[]
): PaletteWorktreeIndex<T> {
  const byHostIdentity = new Map<string, T>()
  const byBareId = new Map<string, T>()
  const byPhysicalHostIdentity = new Map<string, T | null>()
  for (const worktree of worktrees) {
    byHostIdentity.set(getPaletteWorktreeIdentity(worktree), worktree)
    if (!byBareId.has(worktree.id)) {
      byBareId.set(worktree.id, worktree)
    }
    const physicalIdentity = composeWorktreeHostIdentity(worktree.hostId, worktree.id)
    byPhysicalHostIdentity.set(
      physicalIdentity,
      byPhysicalHostIdentity.has(physicalIdentity) ? null : worktree
    )
  }
  for (const [physicalIdentity, worktree] of byPhysicalHostIdentity) {
    if (worktree && !byHostIdentity.has(physicalIdentity)) {
      byHostIdentity.set(physicalIdentity, worktree)
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
