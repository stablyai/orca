import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'

/** The delete dialog's confirmed rows, resolved on the host each identity names. */
export function useDeleteWorktreeDialogTargets(args: {
  allWorktrees: readonly Worktree[]
  worktreeDeleteIdentities: readonly WorktreeDeleteIdentity[]
  worktreeId: string
  worktreeIds: readonly string[]
}): { worktree: Worktree | null; worktrees: Worktree[] } {
  const { allWorktrees, worktreeDeleteIdentities, worktreeId, worktreeIds } = args
  const worktree = useMemo(() => {
    if (!worktreeId) {
      return null
    }
    const identity = worktreeDeleteIdentities.find((item) => item.id === worktreeId)
    return (
      allWorktrees.find(
        (item) => item.id === worktreeId && (!identity?.hostId || item.hostId === identity.hostId)
      ) ?? null
    )
  }, [allWorktrees, worktreeDeleteIdentities, worktreeId])
  const worktrees = useMemo(() => {
    if (worktreeIds.length === 0) {
      return []
    }
    if (worktreeDeleteIdentities.length > 0) {
      const selected = new Set(
        worktreeDeleteIdentities.map((identity) =>
          composeWorktreeHostIdentity(identity.hostId, identity.id)
        )
      )
      return allWorktrees.filter((item) => selected.has(getWorktreeHostIdentity(item)))
    }
    const selected = new Set(worktreeIds)
    return allWorktrees.filter((item) => selected.has(item.id))
  }, [allWorktrees, worktreeDeleteIdentities, worktreeIds])
  return { worktree, worktrees }
}
