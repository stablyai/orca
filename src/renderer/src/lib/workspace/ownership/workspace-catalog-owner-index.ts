import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

export function buildCatalogOwnerIndex<
  T extends { id: string; connectionId?: string | null; executionHostId?: string | null }
>(
  records: readonly T[]
): ReadonlyMap<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }> {
  const next = new Map<string, { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }>()
  for (const record of records) {
    const id = record.id
    const hostId = getRepoExecutionHostId(record)
    const current = next.get(id)
    if (!current) {
      next.set(id, { kind: 'resolved', owner: record })
    } else if (current.kind === 'resolved' && getRepoExecutionHostId(current.owner) !== hostId) {
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

export function worktreeOwnerMatchesHost(
  owner: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>,
  executionHostId: ExecutionHostId
): boolean {
  const physicalHostId = parseExecutionHostId(owner.hostId)?.id
  const runtimeEnvironmentId = owner.runtimeOwnerEnvironmentId?.trim()
  if (!runtimeEnvironmentId) {
    return (physicalHostId ?? 'local') === executionHostId
  }
  const runtimeHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
  return (
    executionHostId === runtimeHostId ||
    (physicalHostId !== undefined && executionHostId === physicalHostId)
  )
}

export function resolveUniqueWorktreeOwnerEntry<
  Entry extends { owner: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'> }
>(
  locations: Entry | Entry[] | undefined,
  executionHostId?: ExecutionHostId
): Entry | 'missing' | 'ambiguous' {
  if (!locations) {
    return 'missing'
  }
  if (!Array.isArray(locations)) {
    return executionHostId && !worktreeOwnerMatchesHost(locations.owner, executionHostId)
      ? 'missing'
      : locations
  }
  let matched: Entry | null = null
  let matchedIdentity: string | null = null
  for (const entry of locations) {
    if (executionHostId && !worktreeOwnerMatchesHost(entry.owner, executionHostId)) {
      continue
    }
    if (!matched) {
      matched = entry
      matchedIdentity = worktreeOwnerIdentity(entry.owner)
    } else if (worktreeOwnerIdentity(entry.owner) !== matchedIdentity) {
      return 'ambiguous'
    }
  }
  return matched ?? 'missing'
}
