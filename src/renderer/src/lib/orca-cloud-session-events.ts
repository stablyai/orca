// Window side of Orca Cloud's session lifecycle: cap warnings and idle sleep requests from main.
import { createElement } from 'react'
import { toast } from 'sonner'
import { CloudStateDot } from '@/components/orca-cloud/CloudStateDot'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { installOrcaCloudWorkspaceStore } from '@/lib/orca-cloud/orca-cloud-workspace-store'

export function installOrcaCloudSessionEvents(): () => void {
  const api = window.api?.ephemeralVm
  if (!api?.onCloudSessionWarning || !api.onCloudIdleSleepRequested) {
    return () => {}
  }
  const disposeWarning = api.onCloudSessionWarning(({ workspaceName, minutesLeft }) => {
    toast.warning(
      translate(
        'auto.lib.orcaCloudSession.restartSoon',
        'Cloud workspace restarts in {{minutes}} min',
        {
          minutes: minutesLeft
        }
      ),
      {
        duration: 20_000,
        description: translate(
          'auto.lib.orcaCloudSession.restartSoonDetail',
          '{{name}} reaches its 24-hour session limit. Files stay; running agents pick up where they left off.',
          {
            name:
              workspaceName ??
              translate('auto.lib.orcaCloudSession.thisWorkspace', 'This workspace')
          }
        )
      }
    )
  })
  const disposeIdle = api.onCloudIdleSleepRequested(({ workspaceId, idleMs }) => {
    const worktree = workspaceId ? findWorktreeById(useAppStore.getState(), workspaceId) : null
    if (!workspaceId || !worktree) {
      return
    }
    void runSleepWorktree(workspaceId).then((results) => {
      if (results.some((result) => result.workspaceId === workspaceId && result.completed)) {
        showIdleSleepNotice(workspaceId, worktree.displayName, idleMs ?? null)
      }
    })
  })
  const disposeStore = installOrcaCloudWorkspaceStore()
  return () => {
    disposeWarning()
    disposeIdle()
    disposeStore()
  }
}

/** "See plans" on the create failure when the account has no plan with cloud hours. */
export function showOrcaCloudPlanUpsell(message: string): void {
  toast.error(message, {
    action: {
      label: translate('auto.lib.orcaCloudSession.seePlans', 'See plans'),
      onClick: () => openPlansPage('sandbox')
    }
  })
}

/** "<name> slept after 20 minutes idle · Wake": the quiet receipt for an automatic sleep. */
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
            count: minutes
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
