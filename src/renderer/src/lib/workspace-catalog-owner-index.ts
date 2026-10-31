import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export function getCatalogOwnerHostId(owner: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostId {
  return getRepoExecutionHostId(owner)
}

export function buildCatalogOwnerIndex<
  T extends { id: string; connectionId?: string | null; executionHostId?: string | null }
>(
  records: readonly T[]
): ReadonlyMap<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }> {
  const next = new Map<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }>()
  for (const record of records) {
    const id = record.id
    const hostId = getCatalogOwnerHostId(record)
    const current = next.get(id)
    if (!current) {
      next.set(id, { kind: 'resolved', owner: record })
    } else if (current.kind === 'resolved' && getCatalogOwnerHostId(current.owner) !== hostId) {
      next.set(id, { kind: 'ambiguous' })
    }
    next.set(`${id}\0${hostId}`, {
      kind: 'resolved',
      owner: record
    })
  }
  return next
}

export function repoOwnerIdentity(owner: Pick<Repo, 'connectionId' | 'executionHostId'>): string {
  return JSON.stringify([owner.executionHostId ?? null, owner.connectionId?.trim() || null])
}

export function worktreeOwnerIdentity(
  owner: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
): string {
  return JSON.stringify([
    owner.repoId,
    owner.hostId ?? null,
    owner.runtimeOwnerEnvironmentId?.trim() || null
  ])
}

export function worktreeOwnerHostIds(
  owner: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
): ExecutionHostId[] {
  const physicalHostId = parseExecutionHostId(owner.hostId)?.id
  const runtimeEnvironmentId = owner.runtimeOwnerEnvironmentId?.trim()
  if (!runtimeEnvironmentId) {
    return [physicalHostId ?? 'local']
  }
  const runtimeHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
  // Why: paired HUB worktrees need logical-runtime lookup without losing their physical SSH route.
  return physicalHostId && physicalHostId !== runtimeHostId
    ? [physicalHostId, runtimeHostId]
    : [runtimeHostId]
}
