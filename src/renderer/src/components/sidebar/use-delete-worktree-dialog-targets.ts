import { useMemo } from 'react'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRegisteredWorktreeDeleteTarget,
  type WorktreeDeleteIdentity
} from './worktree-delete-request'

/** The dialog resolves the exact serving store, host and incarnation captured by the request. */
export function useDeleteWorktreeDialogTargets(args: {
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>
  worktreeDeleteIdentities: readonly WorktreeDeleteIdentity[]
  worktreeId: string
  worktreeIds: readonly string[]
}): { worktree: Worktree | null; worktrees: Worktree[] } {
  const { state, worktreeDeleteIdentities, worktreeId, worktreeIds } = args
  const worktrees = useMemo(() => {
    const requests = worktreeDeleteIdentities.length
      ? worktreeDeleteIdentities
      : worktreeIds.map((id) => ({ id, hostId: undefined }))
    return requests.flatMap((identity) => {
      const row = getRegisteredWorktreeDeleteTarget(state, identity.id, identity.hostId, identity)
      return row ? [row] : []
    })
  }, [state, worktreeDeleteIdentities, worktreeIds])
  return { worktree: worktrees.find((row) => row.id === worktreeId) ?? null, worktrees }
}
