import { useCallback, useContext, useMemo } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { openMoveToThisComputer } from '@/lib/orca-cloud/orca-cloud-move-store'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { runWorktreeDelete } from '@/components/sidebar/workspace-actions/deletion/delete-worktree-flow'
import type { CloudPanelActions } from './CloudWorkspaceStatusPanel'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { isPairedCloudStatusRow } from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import {
  runArchiveCloudWorkspace,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from './cloud-workspace-actions'

/** Restart that asks first while agents are working: the same confirm on every surface. */
export function useConfirmedRestart(workspaceId: string): () => void {
  const confirm = useContext(ConfirmationDialogContext)
  const agentsRunning = useWorktreeActivityStatus(workspaceId) === 'working'
  return useCallback(
    () => void runRestartCloudWorkspace(workspaceId, { agentsRunning, confirm }),
    [workspaceId, agentsRunning, confirm]
  )
}

/**
 * The status panel's actions for one workspace. Restart asks first while agents are working;
 * `close` runs before actions that move focus elsewhere (an overlay or the archived view).
 */
export function useCloudPanelActions(workspaceId: string, close: () => void): CloudPanelActions {
  const confirm = useContext(ConfirmationDialogContext)
  const agentsRunning = useWorktreeActivityStatus(workspaceId) === 'working'
  const name = useAppStore((state) => findWorktreeById(state, workspaceId)?.displayName ?? null)
  // PAIRED-CHROME: main can't archive or move a paired row yet (PAIRED-ARCHIVE). Wake and Restart
  // reach its sandbox (PAIRED-WAKE).
  const paired = useCloudWorkspace((state) => isPairedCloudStatusRow(state, workspaceId))
  return useMemo(() => {
    const all: CloudPanelActions = {
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
      onSleep: () => {
        close()
        void runSleepWorktree(workspaceId)
      },
      onMoveToComputer: () => {
        close()
        openMoveToThisComputer(workspaceId, name ?? workspaceId)
      },
      onDelete: () => {
        close()
        runWorktreeDelete(workspaceId)
      }
    }
    if (!paired) {
      return all
    }
    const { onWake, onRestart, onSleep, onDelete } = all
    return { onWake, onRestart, onSleep, onDelete }
  }, [workspaceId, close, agentsRunning, confirm, name, paired])
}
