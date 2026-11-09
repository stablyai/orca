import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/workspace/activation/worktree-activation'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchivedFresh,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CLOUD_WORKSPACE_ARCHIVED_ERROR } from '../../../../../shared/hosted-sandbox/cloud-workspace-api'
import { isWakeActive } from '@/lib/orca-cloud/orca-cloud-workspace-state'

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  options?: { revealInSidebar?: boolean }
): Promise<void> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
      navigationIntent: 'user-open',
      ...options,
      ...(executionHostId ? { executionHostId } : {})
    })
    return
  }
  // Keep navigation independent from an optional runtime wake IPC.
  activateAndRevealWorktree(worktreeId, {
    navigationIntent: 'user-open',
    revealInSidebar: false,
    ...(executionHostId ? { executionHostId } : {})
  })

  await resumeEphemeralVmWorkspace(worktreeId)
}

/** Wakes the per-workspace VM behind a worktree, if it has one. */
async function resumeEphemeralVmWorkspace(worktreeId: string): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return
  }
  // An archived Orca Cloud workspace opens its read-only archive view; only Unarchive wakes it.
  // A cold start or a stale read must not wake it, so a cloud workspace re-reads its status first.
  const cloud = getCloudWorkspaceSnapshot()
  const maybeCloud = !cloud.idsLoaded || cloud.ids.has(worktreeId)
  if (maybeCloud && (await isCloudWorkspaceArchivedFresh(worktreeId))) {
    return
  }
  try {
    const runtime = await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
    if (runtime?.runtimeEnvironmentId) {
      const store = (await import('@/store/index')).useAppStore
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(CLOUD_WORKSPACE_ARCHIVED_ERROR)) {
      // Archived elsewhere since this window last looked: show the archive instead of failing.
      void refreshCloudWorkspaceStatus(worktreeId)
      return
    }
    if (getCloudWorkspaceSnapshot().ids.has(worktreeId)) {
      // The cloud waking overlay turns into its own failure card; no second toast.
      failCloudWake(worktreeId, message)
      return
    }
    toast.error(
      translate(
        'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
        'Failed to wake ephemeral VM workspace'
      ),
      { description: message }
    )
  }
}

/** Main reports a step failure itself; this covers failures after the step (re-pairing). */
function failCloudWake(worktreeId: string, message: string): void {
  const wake = getCloudWorkspaceSnapshot().wake[worktreeId]
  if (!wake || !isWakeActive(wake, Date.now())) {
    return
  }
  noteCloudWakeProgress({ ...wake, phase: 'failed', at: Date.now(), message })
}
