// The live statuses of a bot's worker workspaces, for its fold's counts and its row line alike.
import { useMemo } from 'react'
import { useWorktreeActivityStatuses } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses'
import { isWorktreeHostDisconnected } from '@/lib/workspace/ownership/worktree-host-disconnected'
import { useAppStore } from '@/store'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getFolderWorkspaceChildWorktrees } from '../../../../shared/folder-workspace-child-worktrees'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'

/** The bot home's worker workspaces, as its sidebar lists them. */
export function useBotWorkerWorkspaces(
  home: FolderWorkspace
): ReturnType<typeof getFolderWorkspaceChildWorktrees> {
  const childrenByParent = useAppStore(selectSidebarChildrenByParentIdentity)
  return useMemo(
    () => getFolderWorkspaceChildWorktrees(getFolderWorkspaceHostIdentity(home), childrenByParent),
    [home, childrenByParent]
  )
}

/** Each workspace's status; a line whose own server is down shows no live work, whatever its bot's server does. */
export function useLiveWorkspaceStatuses(workspaceIds: readonly string[]): WorktreeStatus[] {
  const statusById = useWorktreeActivityStatuses(workspaceIds)
  const downIds = useAppStore((s) =>
    workspaceIds.filter((id) => isWorktreeHostDisconnected(s, id)).join('\n')
  )
  return useMemo(() => {
    const down = new Set(downIds ? downIds.split('\n') : [])
    return [...statusById].flatMap(([id, status]) => (down.has(id) ? [] : [status]))
  }, [statusById, downIds])
}
