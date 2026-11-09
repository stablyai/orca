import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/workspace/activation/worktree-activation'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { EphemeralVmWorkspaceLifecycleResult } from '../../../../../shared/ephemeral-vm-runtimes'
import { ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import { ephemeralVmFailureFromError } from '../../../../../shared/ephemeral-vm-failure-copy'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchivedFresh,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CLOUD_WORKSPACE_ARCHIVED_ERROR } from '../../../../../shared/hosted-sandbox/cloud-workspace-api'
import { isWakeActive } from '@/lib/orca-cloud/orca-cloud-workspace-state'

/** Coded failures render through the catalog; a thrown IPC error only has its message. */
async function settleLifecycleCall(
  call: Promise<EphemeralVmWorkspaceLifecycleResult>
): Promise<EphemeralVmWorkspaceLifecycleResult> {
  try {
    return await call
  } catch (error) {
    return { ok: false, ...ephemeralVmFailureFromError(error) }
  }
}

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

/** Wakes the per-workspace VM behind a worktree, if it has one; host health reads Waking meanwhile. */
export async function resumeEphemeralVmWorkspace(worktreeId: string): Promise<void> {
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
  // Start the wake before loading the store so activation never waits on a module import.
  const resume = window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
  const store = (await import('@/store/index')).useAppStore
  // Every activation asks; only known VM workspaces pay for Waking state and a record re-read.
  const vmStatus = store.getState().ephemeralVmRuntimesByWorkspaceId[worktreeId]?.status
  // A running VM's activation resumes nothing, so it never reads as waking.
  const isVmWorkspace = vmStatus === 'suspended' || vmStatus === 'resume_failed'
  if (isVmWorkspace) {
    store.getState().setEphemeralVmWorkspaceWaking(worktreeId, true)
  }
  try {
    const result = await settleLifecycleCall(resume)
    if (!result.ok) {
      // The record keeps the reason for the row tooltip; the toast reports it now.
      const reason = ephemeralVmErrorText(result)
      if (JSON.stringify(result).includes(CLOUD_WORKSPACE_ARCHIVED_ERROR)) {
        // Archived elsewhere since this window last looked: show the archive instead of failing.
        void refreshCloudWorkspaceStatus(worktreeId)
        return
      }
      if (getCloudWorkspaceSnapshot().ids.has(worktreeId)) {
        // The cloud waking overlay turns into its own failure card; no second toast.
        failCloudWake(worktreeId, reason)
        return
      }
      toast.error(
        translate(
          'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
          'Failed to wake ephemeral VM workspace'
        ),
        // The row's Resume failed tooltip says how to retry; not every failed wake leaves one.
        { description: reason }
      )
      return
    }
    const runtime = result.runtime
    if (runtime?.runtimeEnvironmentId) {
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
    }
  } catch {
    // The VM is awake; host status polling recovers a failed environment refresh.
  } finally {
    if (isVmWorkspace) {
      // Read the settled record before dropping Waking so the row never flashes Suspended.
      await store
        .getState()
        .refreshEphemeralVmRuntimes()
        .catch(() => undefined)
      store.getState().setEphemeralVmWorkspaceWaking(worktreeId, false)
    }
  }
}

/** Suspends a workspace's VM without closing panels (callers sleep panels first when open). */
export async function suspendEphemeralVmWorkspace(worktreeId: string): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.suspendWorkspace) {
    return
  }
  const result = await settleLifecycleCall(
    window.api.ephemeralVm.suspendWorkspace({ workspaceId: worktreeId })
  )
  if (!result.ok) {
    toast.error(translate('workspace.vm.suspendFailed', 'Failed to suspend VM workspace'), {
      description: ephemeralVmErrorText(result)
    })
  }
  const store = (await import('@/store/index')).useAppStore
  await store
    .getState()
    .refreshEphemeralVmRuntimes()
    .catch(() => undefined)
  // The host's last status still reads reachable; re-probe so the header shows Suspended.
  const environmentId =
    store.getState().ephemeralVmRuntimesByWorkspaceId[worktreeId]?.runtimeEnvironmentId
  if (environmentId) {
    await store
      .getState()
      .refreshRuntimeEnvironmentStatus(environmentId)
      .catch(() => undefined)
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
