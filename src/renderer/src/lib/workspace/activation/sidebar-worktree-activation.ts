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
  isCloudWorkspaceArchived,
  noteCloudWakeProgress
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
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
  if (isCloudWorkspaceArchived(worktreeId)) {
    return
  }
  try {
    const runtime = await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
    settleCloudWake(worktreeId, 'ready')
    if (runtime?.runtimeEnvironmentId) {
      const store = (await import('@/store/index')).useAppStore
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
    }
  } catch (error) {
    settleCloudWake(worktreeId, 'failed', error instanceof Error ? error.message : String(error))
    toast.error(
      translate(
        'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
        'Failed to wake ephemeral VM workspace'
      ),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
  }
}

/** Main reports waking/connecting; the window knows when the workspace is usable again. */
function settleCloudWake(
  worktreeId: string,
  phase: 'ready' | 'failed',
  message?: string
): void {
  const wake = getCloudWorkspaceSnapshot().wake[worktreeId]
  if (!wake || !isWakeActive(wake, Date.now())) {
    return
  }
  noteCloudWakeProgress({ ...wake, phase, at: Date.now(), ...(message ? { message } : {}) })
}
