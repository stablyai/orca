import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
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
  /** Pin deletion to the confirmed host because workspace IDs repeat across hosts. */
  expectedHostId?: ExecutionHostId
}

export type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (target: WorktreeRemovalTarget) => void
  onPreservedBranch?: (branch: PreservedBranchCleanup) => void
  suppressPreservedBranchToast?: boolean
  snapshotPruneBatchId?: string
  confirmedDiscards?: ConfirmedUnsavedDiscards
  /** Throws when the confirmed workspace is gone; runs before every destructive send. */
  assertBeforeDispatch?: () => void
}

export function toWorktreeDeleteIdentities(
  worktrees: readonly Pick<Worktree, 'id' | 'instanceId' | 'hostId'>[]
): WorktreeDeleteIdentity[] {
  return worktrees.map(({ id, instanceId, hostId }) => ({ id, instanceId, hostId }))
}

export type WorktreeDeleteTargetLookup = (
  worktreeId: string,
  hostId: ExecutionHostId | undefined
) => Worktree | undefined

export function resolveWorktreeBatchDeleteTargets(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  lookupTarget: WorktreeDeleteTargetLookup
): Worktree[] | null {
  // Deduplicate by ID and host so a same-ID twin cannot disappear from the confirmed batch.
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
    // Resolve an explicit host exactly so remote deletion cannot fall through to a local twin.
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
