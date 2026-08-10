import type { Worktree } from '../../../../shared/types'

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
  // Batch deletion commits one focus handoff after all targets settle.
  focusSuccessorOnDelete?: boolean
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
