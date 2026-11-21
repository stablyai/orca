import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
// The live statuses of a bot's worker workspaces, for its fold's counts and its row line alike.
import { useCallback, useMemo } from 'react'
import { useWorktreeActivityStatuses } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses'
import { selectLiveAgentStatusEntriesForWorktree } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { isWorktreeHostDisconnected } from '@/lib/workspace/ownership/worktree-host-disconnected'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getFolderWorkspaceChildWorktrees } from '../../../../shared/folder-workspace-child-worktrees'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { botWorkerWorkspaceStatus } from '../../../../shared/bots/bot-sidebar-workspaces'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'

/** The bot home's worker workspaces, as its sidebar lists them. */
export function useBotWorkerWorkspaces(
  home: FolderWorkspace
): ReturnType<typeof getFolderWorkspaceChildWorktrees> {
  const childrenByParent = useAppStoreWithHostStatuses(selectSidebarChildrenByParentIdentity)
  return useMemo(
    () => getFolderWorkspaceChildWorktrees(getFolderWorkspaceHostIdentity(home), childrenByParent),
    [home, childrenByParent]
  )
}

/** Worker workspaces' statuses as bot surfaces count them (`botWorkerWorkspaceStatus`). */
export function useBotWorkerWorkspaceStatuses(
  workspaceIds: readonly string[]
): Map<string, WorktreeStatus> {
  const statusById = useWorktreeActivityStatuses(workspaceIds)
  // Joined ids keep the selector's result stable between unrelated store writes.
  const selectAsking = useCallback(
    (state: AppState) =>
      workspaceIds
        .filter((id) =>
          selectLiveAgentStatusEntriesForWorktree(state, id).some(
            (entry) => entry.state === 'blocked' || entry.state === 'waiting'
          )
        )
        .join('\n'),
    [workspaceIds]
  )
  const askingIds = useAppStore(selectAsking)
  return useMemo(() => {
    const asking = new Set(askingIds ? askingIds.split('\n') : [])
    return new Map(
      [...statusById].map(([id, status]) => [id, botWorkerWorkspaceStatus(status, asking.has(id))])
    )
  }, [statusById, askingIds])
}

/** Each workspace's status; a line whose own server is down shows no live work, whatever its bot's server does. */
export function useLiveWorkspaceStatuses(workspaceIds: readonly string[]): WorktreeStatus[] {
  const statusById = useBotWorkerWorkspaceStatuses(workspaceIds)
  const downIds = useAppStoreWithHostStatuses((s, statuses) =>
    workspaceIds.filter((id) => isWorktreeHostDisconnected(s, statuses, id)).join('\n')
  )
  return useMemo(() => {
    const down = new Set(downIds ? downIds.split('\n') : [])
    return [...statusById].flatMap(([id, status]) => (down.has(id) ? [] : [status]))
  }, [statusById, downIds])
}
