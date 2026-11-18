import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { isWorkspaceFlagSet } from '@/store/slices/workspace-attention/workspace-unread-flag-reads'
import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** An open room reads the unread a member's reply raised on its home while it was already on
 *  screen; the window's scan settles the flag only when a screen arrives. */
export function useBotGroupRoomRead(
  folderWorkspaceId: string | undefined,
  isVisible: boolean
): void {
  const workspaceId = folderWorkspaceId === undefined ? null : folderWorkspaceKey(folderWorkspaceId)
  const unread = useAppStore((s) => workspaceId !== null && isWorkspaceFlagSet(s, workspaceId))
  useEffect(() => {
    if (unread && isVisible && workspaceId !== null && isOrcaWindowForegroundFocused()) {
      useAppStore
        .getState()
        .readOnScreenAttention(
          { workspaceIds: [workspaceId], targets: [] },
          { screenArrived: true }
        )
    }
  }, [unread, isVisible, workspaceId])
}
