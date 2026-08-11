import type { Worktree } from '../../../../shared/types'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'

export type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  onDeleted?: (worktreeIds: string[]) => void
}

export type WorktreeDeleteIdentity = Pick<Worktree, 'id' | 'instanceId'>

export type WorktreeDeleteOptions = {
  expectedInstanceId?: string
}

export type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (worktreeId: string) => void
  onPreservedBranch?: (branch: PreservedBranchCleanup) => void
  suppressPreservedBranchToast?: boolean
  // Batch deletion commits one focus handoff after all targets settle.
  focusSuccessorOnDelete?: boolean
}

export function toWorktreeDeleteIdentities(
  worktrees: readonly Pick<Worktree, 'id' | 'instanceId'>[]
): WorktreeDeleteIdentity[] {
  return worktrees.map(({ id, instanceId }) => ({ id, instanceId }))
}

export function resolveWorktreeBatchDeleteTargets(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] | null {
  const uniqueRequests = Array.from(
    new Map(
      requestedWorktrees.map(
        (request) => [typeof request === 'string' ? request : request.id, request] as const
      )
    ).values()
  )
  const targets: Worktree[] = []
  for (const request of uniqueRequests) {
    const worktreeId = typeof request === 'string' ? request : request.id
    const target = worktreeMap.get(worktreeId) ?? null
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
    return instanceId === undefined || typeof instanceId === 'string'
      ? [{ id: entry.id, instanceId }]
      : []
  })
}
