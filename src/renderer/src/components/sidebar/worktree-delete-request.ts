import type { Worktree } from '../../../../shared/worktree/types'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'

export type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  forceOnConfirm?: boolean
  onDeleted?: (targets: WorktreeRemovalTarget[]) => void
}

/** `hostId` rides along because `id` alone repeats across hosts (STA-4343). */
export type WorktreeDeleteIdentity = Pick<Worktree, 'id' | 'instanceId' | 'hostId'>

export type WorktreeDeleteOptions = {
  expectedInstanceId?: string
  /** Why (STA-4343): the id-keyed map holds one row per `repoId::path`, so a row
   *  that knows its host must say so or the delete lands on the other one. */
  expectedHostId?: ExecutionHostId
}

export type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (target: WorktreeRemovalTarget) => void
  onPreservedBranch?: (branch: PreservedBranchCleanup) => void
  suppressPreservedBranchToast?: boolean
  snapshotPruneBatchId?: string
  // Batch deletion commits one focus handoff after all targets settle.
  focusSuccessorOnDelete?: boolean
}

export function toWorktreeDeleteIdentities(
  worktrees: readonly Pick<Worktree, 'id' | 'instanceId' | 'hostId'>[]
): WorktreeDeleteIdentity[] {
  return worktrees.map(({ id, instanceId, hostId }) => ({ id, instanceId, hostId }))
}

/** Resolves one confirmed row: the id ALONE is not enough, so the host rides along. */
export type WorktreeDeleteTargetLookup = (
  worktreeId: string,
  hostId: ExecutionHostId | undefined
) => Worktree | undefined

export function resolveWorktreeBatchDeleteTargets(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  lookupTarget: WorktreeDeleteTargetLookup
): Worktree[] | null {
  // Why (STA-4343): dedup on (id, host), not id — two hosts can publish the same
  // `repoId::path`, and collapsing them here would silently drop one confirmed row.
  const uniqueRequests = Array.from(
    new Map(
      requestedWorktrees.map((request) => {
        const key = typeof request === 'string' ? request : `${request.hostId ?? ''}|${request.id}`
        return [key, request] as const
      })
    ).values()
  )
  const targets: Worktree[] = []
  for (const request of uniqueRequests) {
    const worktreeId = typeof request === 'string' ? request : request.id
    // A request that names a host resolves on THAT host, so confirming a remote
    // row can never fall through to a local checkout at the same path — and the
    // other host's row stays reachable instead of being masked by the id-keyed map.
    const target =
      lookupTarget(worktreeId, typeof request === 'string' ? undefined : request.hostId) ?? null
    if (typeof request !== 'string' && (!target || target.instanceId !== request.instanceId)) {
      return null
    }
    if (target && !target.isMainWorktree) {
      targets.push(target)
    }
  }
  return targets
}

export function readWorktreeDeleteIdentities(value: unknown): WorktreeDeleteIdentity[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') {
      return []
    }
    const instanceId = 'instanceId' in entry ? entry.instanceId : undefined
    if (instanceId !== undefined && typeof instanceId !== 'string') {
      return []
    }
    const hostId = normalizeExecutionHostId(
      'hostId' in entry && typeof entry.hostId === 'string' ? entry.hostId : null
    )
    return [{ id: entry.id, instanceId, ...(hostId ? { hostId } : {}) }]
  })
}
