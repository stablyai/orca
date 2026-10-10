import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { getFolderWorkspaceHostId } from '@/store/folder-workspaces/folder-workspace-catalog'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'

/** Resolves the edited workspace within its execution host, including folders. */
export function useWorktreeMetaWorkspace(args: {
  worktreeId: string
  /** The repo bucket the opening row belongs to, when it knows. */
  ownerRepoId: string | null
  executionHostId?: ExecutionHostId
}): {
  worktree: Worktree | undefined
  isFolderWorkspace: boolean
} {
  const { worktreeId, ownerRepoId, executionHostId } = args
  const workspaceScope = useMemo(() => parseWorkspaceKey(worktreeId), [worktreeId])
  const indexedWorktree = useAppStore((s) => {
    // Why: the same workspace ID can exist under two hosts, which the owner index
    // reports as ambiguous rather than guessing. The row that opened the dialog
    // knows which one it is; the index stays the fallback for callers that cannot.
    const owner = executionHostId
      ? findIndexedWorktreeOwnerForHost(s.worktreesByRepo, worktreeId, executionHostId)
      : findIndexedWorktreeOwner(s.worktreesByRepo, worktreeId)
    return owner && (!ownerRepoId || owner.repoId === ownerRepoId)
      ? s.worktreesByRepo[owner.repoId]?.find((item) => item === owner)
      : undefined
  })
  // Why: folder workspaces are absent from worktreesByRepo, so the lookup above
  // returns undefined and the row renders blank for them. The selector returns
  // the stored record — a stable reference — and the projection happens outside
  // it, because a selector that built the object would return a fresh identity
  // on every store write and re-render the dialog continuously.
  const folderWorkspace = useAppStore((s) => {
    if (workspaceScope?.type !== 'folder') {
      return null
    }
    const candidates = s.folderWorkspaces.filter(
      (item) =>
        item.id === workspaceScope.folderWorkspaceId &&
        (!executionHostId || getFolderWorkspaceHostId(item, s.projectGroups) === executionHostId)
    )
    return candidates.length === 1 ? candidates[0] : null
  })
  const worktree = useMemo(
    () => (folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : indexedWorktree),
    [folderWorkspace, indexedWorktree]
  )
  return {
    worktree,
    isFolderWorkspace: workspaceScope?.type === 'folder'
  }
}
