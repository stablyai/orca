import { useContext, useMemo } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { openMoveToThisComputer } from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudPanelActions } from './CloudWorkspaceStatusPanel'
import {
  runArchiveCloudWorkspace,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from './cloud-workspace-actions'

/**
 * The status panel's actions for one workspace. Restart asks first while agents are working;
 * `close` runs before actions that move focus elsewhere (an overlay or the archived view).
 */
export function useCloudPanelActions(workspaceId: string, close: () => void): CloudPanelActions {
  const confirm = useContext(ConfirmationDialogContext)
  const agentsRunning = useWorktreeActivityStatus(workspaceId) === 'working'
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  return useMemo(
    () => ({
      onWake: () => {
        close()
        void wakeCloudWorkspace(workspaceId)
      },
      onRestart: () => void runRestartCloudWorkspace(workspaceId, { agentsRunning, confirm }),
      onArchive: () => {
        close()
        void runArchiveCloudWorkspace(workspaceId, { name })
      },
      onUnarchive: () => {
        close()
        void runUnarchiveCloudWorkspace(workspaceId)
      },
      onMoveToComputer: () => {
        close()
        openMoveToThisComputer(workspaceId, name ?? workspaceId)
      }
    }),
    [workspaceId, close, agentsRunning, confirm, name]
  )
}
