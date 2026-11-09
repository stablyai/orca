// Window side of Orca Cloud's session lifecycle: cap warnings, rollovers and idle sleep from main.
import { createElement } from 'react'
import { toast } from 'sonner'
import { CloudStateDot } from '@/components/orca-cloud/CloudStateDot'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import {
  installOrcaCloudWorkspaceStore,
  noteCloudRolloverState
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { HostedSessionRestartResult } from '../../../shared/hosted-sandbox/hosted-session-events'
import {
  dismissOrcaCloudRestartWarning,
  noteOrcaCloudRolloverState,
  showOrcaCloudRestartWarningToast
} from '@/lib/orca-cloud-session-toasts'

function openWorkspace(workspaceId: string): void {
  if (findWorktreeById(useAppStore.getState(), workspaceId)) {
    void activateWorktreeFromSidebar(workspaceId)
    return
  }
  toast.error(
    translate('auto.lib.orcaCloudSession.workspaceGone', 'That workspace is no longer in Orca.')
  )
}

/** The sidebar's name for the workspace; main only knows the name it was created with. */
function displayName(
  workspaceId: string | null,
  fallback: string | null | undefined
): string | null {
  const worktree = workspaceId ? findWorktreeById(useAppStore.getState(), workspaceId) : undefined
  return worktree?.displayName || fallback || null
}

function restartNow(workspaceId: string): Promise<HostedSessionRestartResult> {
  return window.api.ephemeralVm.restartCloudSession({ workspaceId })
}

export function installOrcaCloudSessionEvents(): () => void {
  const api = window.api?.ephemeralVm
  if (!api?.onCloudSessionWarning || !api.onCloudIdleSleepRequested) {
    return () => {}
  }
  const disposeWarning = api.onCloudSessionWarning((event) =>
    showOrcaCloudRestartWarningToast(
      { ...event, workspaceName: displayName(event.workspaceId, event.workspaceName) },
      { restartNow, open: openWorkspace }
    )
  )
  const disposeState =
    api.onCloudSessionState?.(({ workspaceId, state }) => {
      if (workspaceId) {
        noteOrcaCloudRolloverState(workspaceId, displayName(workspaceId, null), state)
        noteCloudRolloverState(workspaceId, state)
      }
    }) ?? (() => {})
  const disposeIdle = api.onCloudIdleSleepRequested(({ workspaceId, idleMs }) => {
    const worktree = workspaceId ? findWorktreeById(useAppStore.getState(), workspaceId) : null
    if (!workspaceId || !worktree) {
      return
    }
    void runSleepWorktree(workspaceId).then((results) => {
      if (results.some((result) => result.workspaceId === workspaceId && result.completed)) {
        dismissOrcaCloudRestartWarning(workspaceId)
        showIdleSleepNotice(workspaceId, worktree.displayName, idleMs ?? null)
      }
    })
  })
  const disposeStore = installOrcaCloudWorkspaceStore()
  return () => {
    disposeWarning()
    disposeState()
    disposeIdle()
    disposeStore()
  }
}

/** "See plans" on the create failure when the team has no plan with sandbox hours. */
export function showOrcaCloudPlanUpsell(message: string): void {
  toast.error(message, {
    action: {
      label: translate('auto.lib.orcaCloudSession.seePlans', 'See plans'),
      onClick: () => openPlansPage('sandbox')
    }
  })
}

/** "<name> slept after N minutes idle · Wake" (N from the control plane): the quiet receipt for an automatic sleep. */
export function showIdleSleepNotice(
  workspaceId: string,
  name: string,
  idleMs: number | null
): void {
  const minutes = idleMs ? Math.max(1, Math.round(idleMs / 60_000)) : null
  toast(
    minutes
      ? translate(
          'orcaCloudWorkspace.idleSleptMinutes',
          '{{name}} slept after {{count}} minutes idle',
          {
            name,
            count: minutes,
            defaultValue_one: '{{name}} slept after {{count}} minute idle'
          }
        )
      : translate('orcaCloudWorkspace.idleSleptNoTime', '{{name}} went to sleep while idle', {
          name
        }),
    {
      id: `orca-cloud-idle-sleep:${workspaceId}`,
      // The same hollow "asleep" dot the sidebar shows for this workspace.
      icon: createElement(CloudStateDot, { state: 'sleeping', size: 'md' }),
      duration: 8_000,
      description: translate(
        'orcaCloudWorkspace.idleSleptDetail',
        'Files and chats are saved. It uses no sandbox hours until you open it.'
      ),
      action: {
        label: translate('orcaCloudWorkspace.wake', 'Wake'),
        onClick: () => void activateWorktreeFromSidebar(workspaceId)
      }
    }
  )
}
