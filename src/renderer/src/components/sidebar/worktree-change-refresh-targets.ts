import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'

// Edits and new files never touch the index, so only this safety pass can notice them.
export const WORKTREE_CHANGE_SUMMARY_STALE_MS = 60_000

export function isActiveWorktreeRow(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  activeWorktreeId: string | null,
  activeExecutionHostId: string | null
): boolean {
  return (
    worktree.id === activeWorktreeId &&
    (!activeExecutionHostId || (worktree.hostId ?? 'local') === activeExecutionHostId)
  )
}

/** Visible inactive checkouts due for a status read: signaled first, then never read, then oldest. */
export function selectWorktreeChangeRefreshTargets(args: {
  visibleWorktrees: readonly Worktree[]
  activeWorktreeId: string | null
  activeExecutionHostId: string | null
  lastReadAtByIdentity: ReadonlyMap<HostScopedWorktreeKey, number>
  signaledIdentities: ReadonlySet<HostScopedWorktreeKey>
  now: number
  // Passive reads must not trigger macOS other-app data prompts.
  isProtectedPath: (path: string) => boolean
}): Worktree[] {
  const due: { worktree: Worktree; rank: number; lastReadAt: number }[] = []
  for (const worktree of args.visibleWorktrees) {
    if (
      isActiveWorktreeRow(worktree, args.activeWorktreeId, args.activeExecutionHostId) ||
      args.isProtectedPath(worktree.path)
    ) {
      continue
    }
    const identity = getWorktreeHostIdentity(worktree)
    const lastReadAt = args.lastReadAtByIdentity.get(identity)
    if (args.signaledIdentities.has(identity)) {
      due.push({ worktree, rank: 0, lastReadAt: lastReadAt ?? 0 })
    } else if (lastReadAt === undefined) {
      due.push({ worktree, rank: 1, lastReadAt: 0 })
    } else if (args.now - lastReadAt >= WORKTREE_CHANGE_SUMMARY_STALE_MS) {
      due.push({ worktree, rank: 2, lastReadAt })
    }
  }
  return due
    .sort((left, right) => left.rank - right.rank || left.lastReadAt - right.lastReadAt)
    .map(({ worktree }) => worktree)
}
