import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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
    // Prefer the dialog’s host over an ambiguous owner-index result for twin workspace IDs.
    const owner = executionHostId
      ? findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(s), worktreeId, executionHostId)
      : findIndexedWorktreeOwner(selectWorktreesByRepo(s), worktreeId)
    return owner && (!ownerRepoId || owner.repoId === ownerRepoId)
      ? selectWorktreesByRepo(s)[owner.repoId]?.find((item) => item === owner)
      : undefined
  })
  // Folder rows need a separate selector; keep the stored reference stable and project outside the subscription.
  const folderWorkspace = useAppStore((s) => {
    if (workspaceScope?.type !== 'folder') {
      return null
    }
    const candidates = selectFolderWorkspaces(s).filter(
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
