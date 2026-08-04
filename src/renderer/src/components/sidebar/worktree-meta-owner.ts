import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/types'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'

export function findWorktreeMetaOwner(
  worktreesByRepo: Record<string, readonly Worktree[]>,
  worktreeId: string,
  ownerRepoId?: string | null,
  ownerExecutionHostId?: ExecutionHostId | null
): Worktree | undefined {
  if (ownerRepoId) {
    const matches = (worktreesByRepo[ownerRepoId] ?? []).filter(
      (worktree) =>
        worktree.id === worktreeId &&
        (!ownerExecutionHostId ||
          getWorktreeExecutionHostId(worktree, undefined) === ownerExecutionHostId)
    )
    if (matches.length > 0) {
      // Why: duplicate rows with the same owner identity must fail closed instead of using array order.
      return matches.length === 1 ? matches[0] : undefined
    }
    if (ownerExecutionHostId) {
      // Why: an explicit row owner cannot fall through to another repo bucket on the same host.
      return undefined
    }
  }

  const indexedOwner = ownerExecutionHostId
    ? findIndexedWorktreeOwnerForHost(worktreesByRepo, worktreeId, ownerExecutionHostId)
    : findIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  if (!indexedOwner) {
    return undefined
  }
  return worktreesByRepo[indexedOwner.repoId]?.find((worktree) => worktree === indexedOwner)
}
