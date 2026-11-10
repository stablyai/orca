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
  isCloudWorkspaceArchived,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatusIfStale,
  refreshCloudWorkspaceStatus
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  beginWorkspaceWake,
  endWorkspaceWake
} from '@/components/terminal-pane/input/wake-input-buffer'
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
  options?: {
    revealInSidebar?: boolean
    /** False when the caller reports a failed wake itself (one failure message, not two). */
    reportWakeFailure?: boolean
  }
): Promise<EphemeralVmWakeOutcome> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
      navigationIntent: 'user-open',
      ...(options?.revealInSidebar !== undefined
        ? { revealInSidebar: options.revealInSidebar }
        : {}),
      ...(executionHostId ? { executionHostId } : {})
    })
    return { ok: true }
  }
  // Keep navigation independent from an optional runtime wake IPC.
  activateAndRevealWorktree(worktreeId, {
    navigationIntent: 'user-open',
    revealInSidebar: false,
    ...(executionHostId ? { executionHostId } : {})
  })

  return resumeEphemeralVmWorkspace(worktreeId, {
    reportFailure: options?.reportWakeFailure ?? true
  })
}

/** How a wake went: ok also when there was nothing to wake (or it is archived: never woken). */
export type EphemeralVmWakeOutcome = { ok: true } | { ok: false; reason: string }

/** Wakes the per-workspace VM behind a worktree, if it has one; host health reads Waking meanwhile. */
export async function resumeEphemeralVmWorkspace(
  worktreeId: string,
  options: { reportFailure?: boolean } = {}
): Promise<EphemeralVmWakeOutcome> {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return { ok: true }
  }
  // An archived Orca Cloud workspace opens its read-only archive view; only Unarchive wakes it.
  // A cold start or a stale read must not wake it, so a cloud workspace re-reads its status first.
  const cloud = getCloudWorkspaceSnapshot()
  const maybeCloud = !cloud.idsLoaded || cloud.ids.has(worktreeId)
  // Known archived: never wake. Otherwise don't wait on a status round trip before waking: main
  // and the control plane both refuse to resume an archive, and that refusal shows the archive.
  if (maybeCloud && isCloudWorkspaceArchived(worktreeId)) {
    return { ok: true }
  }
  if (maybeCloud) {
    void refreshCloudWorkspaceStatusIfStale(worktreeId, 30_000)
  }
  // Typing from the click on is accepted and delivered to the woken terminal.
  const startedAt = Date.now()
  const cloudAsleep = cloud.status[worktreeId]?.status?.state === 'sleeping'
  if (cloudAsleep) {
    beginWorkspaceWake(worktreeId, startedAt)
  }
  // Start the wake before loading the store so activation never waits on a module import.
  const resume = window.api.ephemeralVm.resumeWorkspace({
    workspaceId: worktreeId
  })
  const store = (await import('@/store/index')).useAppStore
  // Every activation asks; only known VM workspaces pay for Waking state and a record re-read.
  const vmStatus = store.getState().ephemeralVmRuntimesByWorkspaceId[worktreeId]?.status
  // A running VM's activation resumes nothing, so it never reads as waking.
  const isVmWorkspace = vmStatus === 'suspended' || vmStatus === 'resume_failed'
  if (isVmWorkspace) {
    store.getState().setEphemeralVmWorkspaceWaking(worktreeId, true)
    beginWorkspaceWake(worktreeId, startedAt)
  }
  const wakeHeld = cloudAsleep || isVmWorkspace
  void resume
    .then(
      (result) => result,
      () => null
    )
    .then((result) => {
      if (!wakeHeld) {
        return
      }
      // A wake main reports (waking → ready/failed) settles the hold itself; the answer to this
      // call can come before the woken terminal is attached. Settle here only when no wake ran.
      if (getCloudWorkspaceSnapshot().wake[worktreeId]) {
        return
      }
      endWorkspaceWake(worktreeId, result && result.ok !== false ? 'ready' : 'failed')
    })
  try {
    const result = await settleLifecycleCall(resume)
    if (!result.ok) {
      // The record keeps the reason for the row tooltip; the toast reports it now.
      const reason = ephemeralVmErrorText(result)
      if (JSON.stringify(result).includes(CLOUD_WORKSPACE_ARCHIVED_ERROR)) {
        // Archived elsewhere since this window last looked: show the archive instead of failing.
        void refreshCloudWorkspaceStatus(worktreeId)
        return { ok: true }
      }
      if (getCloudWorkspaceSnapshot().ids.has(worktreeId)) {
        // The cloud waking overlay turns into its own failure card; no second toast.
        failCloudWake(worktreeId, reason)
        return { ok: false, reason }
      }
      if (options.reportFailure === false) {
        return { ok: false, reason }
      }
      toast.error(
        translate(
          'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
          'Failed to wake ephemeral VM workspace'
        ),
        // The row's Resume failed tooltip says how to retry; not every failed wake leaves one.
        { description: reason }
      )
      return { ok: false, reason }
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
  return { ok: true }
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
