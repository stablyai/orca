import { worktreeCopyOwnerKey } from '@/store/slices/worktrees/metadata/worktree-copy-review-clear'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../../shared/worktree/host-qualified-identity'

// Edits and new files never touch the index, so only this safety pass can notice them.
export const WORKTREE_CHANGE_SUMMARY_STALE_MS = 60_000

function isActiveWorktreeRow(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  activeWorktreeId: string | null,
  activeExecutionHostId: string | null
): boolean {
  return (
    worktree.id === activeWorktreeId &&
    (!activeExecutionHostId || (worktree.hostId ?? 'local') === activeExecutionHostId)
  )
}

/**
 * The active row whose polled status can be mirrored. The polled map is keyed by bare id, so a
 * row with a same-id copy on another host returns null and is read like any inactive card.
 */
export function selectMirroredActiveWorktree(
  repoWorktrees: readonly Worktree[],
  activeWorktreeId: string | null,
  activeExecutionHostId: string | null
): Worktree | null {
  const active = repoWorktrees.find((worktree) =>
    isActiveWorktreeRow(worktree, activeWorktreeId, activeExecutionHostId)
  )
  if (!active) {
    return null
  }
  const copies = new Set(
    repoWorktrees
      .filter((worktree) => worktree.id === active.id)
      .map((worktree) => worktreeCopyOwnerKey(worktree))
  )
  return copies.size === 1 ? active : null
}

/** Visible checkouts due for a status read: signaled first, then never read, then oldest. */
export function selectWorktreeChangeRefreshTargets(args: {
  visibleWorktrees: readonly Worktree[]
  mirroredIdentity: HostScopedWorktreeKey | null
  lastReadAtByIdentity: ReadonlyMap<HostScopedWorktreeKey, number>
  signaledIdentities: ReadonlySet<HostScopedWorktreeKey>
  now: number
  // Passive reads must not trigger macOS other-app data prompts.
  isProtectedPath: (path: string) => boolean
}): Worktree[] {
  const due: { worktree: Worktree; rank: number; lastReadAt: number }[] = []
  for (const worktree of args.visibleWorktrees) {
    const identity = getWorktreeHostIdentity(worktree)
    if (identity === args.mirroredIdentity || args.isProtectedPath(worktree.path)) {
      continue
    }
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
