// Window side of Orca Cloud's session lifecycle: cap warnings and idle sleep requests from main.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'

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
  const disposeIdle = api.onCloudIdleSleepRequested(({ workspaceId }) => {
    if (workspaceId && findWorktreeById(useAppStore.getState(), workspaceId)) {
      void runSleepWorktree(workspaceId)
    }
  })
  return () => {
    disposeWarning()
    disposeIdle()
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
