import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/workspace/activation/worktree-activation'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { EphemeralVmWorkspaceLifecycleResult } from '../../../../../shared/ephemeral-vm-runtimes'
import { ephemeralVmErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { ephemeralVmFailureFromError } from '../../../../../shared/ephemeral-vm-failure-copy'

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
