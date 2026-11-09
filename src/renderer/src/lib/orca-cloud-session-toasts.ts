// Toasts for Orca Cloud's session lifecycle: the 24h restart and cancel cleanup.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  HostedSessionRestartResult,
  HostedSessionStateEvent,
  HostedSessionWarningEvent
} from '../../../shared/hosted-sandbox/hosted-session-events'

/** The final warning tier stays up until the user acts or the restart happens. */
export const ORCA_CLOUD_PERSISTENT_WARNING_MINUTES = 5
const WARNING_DURATION_MS = 20_000
// Sonner merges an update into the toast with the same id; drop the warning's buttons explicitly.
const WITHOUT_WARNING_ACTIONS = { action: undefined, cancel: undefined }

export type OrcaCloudRestartToastActions = {
  restartNow: (workspaceId: string) => Promise<HostedSessionRestartResult>
  open: (workspaceId: string) => void
}

function workspaceLabel(name: string | null | undefined): string {
  return name ?? translate('auto.lib.orcaCloudSession.thisWorkspaceLower', 'this workspace')
}

function restartToastId(workspaceId: string | null): string {
  return `orca-cloud-restart:${workspaceId ?? 'unknown'}`
}

// Workspaces whose restart warning is on screen, and those restarting from "Restart now".
const warnedWorkspaces = new Set<string>()
const restartsInFlight = new Set<string>()

export function showOrcaCloudRestartWarningToast(
  event: HostedSessionWarningEvent,
  actions: OrcaCloudRestartToastActions
): void {
  const { workspaceId, workspaceName, minutesLeft } = event
  // A later tier must not bring the buttons back over a restart already under way.
  if (workspaceId && restartsInFlight.has(workspaceId)) {
    return
  }
  if (workspaceId) {
    warnedWorkspaces.add(workspaceId)
  }
  const id = restartToastId(workspaceId)
  const persistent = minutesLeft <= ORCA_CLOUD_PERSISTENT_WARNING_MINUTES
  toast.warning(
    translate(
      'auto.lib.orcaCloudSession.sandboxRestartSoon',
      'Sandbox for {{name}} restarts in {{minutes}} min',
      { name: workspaceLabel(workspaceName), minutes: minutesLeft }
    ),
    {
      id,
      duration: persistent ? Number.POSITIVE_INFINITY : WARNING_DURATION_MS,
      description: translate(
        'auto.lib.orcaCloudSession.sandboxRestartSoonDetail',
        'Cloud sandboxes restart after 24 hours. Files are kept and Orca resumes your agents after the restart.'
      ),
      ...(workspaceId
        ? {
            action: {
              label: translate('auto.lib.orcaCloudSession.restartNow', 'Restart now'),
              onClick: (clickEvent) => {
                // Keep the toast: it turns into the restart's progress and result.
                clickEvent.preventDefault()
                void runOrcaCloudRestartNow(event, actions.restartNow)
              }
            },
            cancel: {
              label: translate('auto.lib.orcaCloudSession.open', 'Open'),
              onClick: () => actions.open(workspaceId)
            }
          }
        : {})
    }
  )
}

async function runOrcaCloudRestartNow(
  event: HostedSessionWarningEvent,
  restartNow: OrcaCloudRestartToastActions['restartNow']
): Promise<void> {
  if (!event.workspaceId) {
    return
  }
  const { workspaceId } = event
  restartsInFlight.add(workspaceId)
  warnedWorkspaces.delete(workspaceId)
  showOrcaCloudRestartingToast(workspaceId, event.workspaceName)
  const result = await restartNow(workspaceId)
    .catch((): HostedSessionRestartResult => ({ status: 'failed' }))
    .finally(() => restartsInFlight.delete(workspaceId))
  if (result.status === 'restarted') {
    showOrcaCloudRestartedToast(workspaceId, event.workspaceName)
    return
  }
  showOrcaCloudRestartFailedToast(workspaceId, event.workspaceName, result.status)
}

function showOrcaCloudRestartFailedToast(
  workspaceId: string,
  workspaceName: string | null,
  status: 'not-running' | 'failed'
): void {
  const id = restartToastId(workspaceId)
  const name = workspaceLabel(workspaceName)
  toast.error(
    translate(
      'auto.lib.orcaCloudSession.sandboxRestartFailed',
      "Couldn't restart the sandbox for {{name}}",
      { name }
    ),
    {
      id,
      ...WITHOUT_WARNING_ACTIONS,
      duration: WARNING_DURATION_MS,
      description:
        status === 'not-running'
          ? translate(
              'auto.lib.orcaCloudSession.restartNotRunning',
              "The sandbox isn't running. Open the workspace to wake it."
            )
          : translate(
              'auto.lib.orcaCloudSession.restartFailedDetail',
              'It still restarts on its own after 24 hours.'
            )
    }
  )
}

function showOrcaCloudRestartedToast(workspaceId: string, workspaceName: string | null): void {
  toast.success(
    translate('auto.lib.orcaCloudSession.sandboxRestarted', 'Sandbox for {{name}} restarted', {
      name: workspaceLabel(workspaceName)
    }),
    {
      id: restartToastId(workspaceId),
      ...WITHOUT_WARNING_ACTIONS,
      duration: WARNING_DURATION_MS,
      description: translate(
        'auto.lib.orcaCloudSession.restartedResumingDetail',
        'Files are kept and Orca is resuming your agents. The next restart is in 24 hours.'
      )
    }
  )
}

/** A scheduled rollover: a warning still on screen turns into its progress and result, so its
 *  "Restart now" can't start a second one. Quiet rollovers nobody was warned about stay quiet. */
export function noteOrcaCloudRolloverState(
  workspaceId: string,
  workspaceName: string | null,
  state: HostedSessionStateEvent['state']
): void {
  if (restartsInFlight.has(workspaceId) || !warnedWorkspaces.has(workspaceId)) {
    return
  }
  if (state === 'restarting') {
    showOrcaCloudRestartingToast(workspaceId, workspaceName)
    return
  }
  warnedWorkspaces.delete(workspaceId)
  if (state === 'running') {
    showOrcaCloudRestartedToast(workspaceId, workspaceName)
  } else {
    showOrcaCloudRestartFailedToast(workspaceId, workspaceName, 'failed')
  }
}

/** The workspace slept instead of restarting; its restart warning no longer applies. */
export function dismissOrcaCloudRestartWarning(workspaceId: string): void {
  if (warnedWorkspaces.delete(workspaceId)) {
    toast.dismiss(restartToastId(workspaceId))
  }
}

export function showOrcaCloudRestartingToast(
  workspaceId: string,
  workspaceName: string | null
): void {
  toast.loading(
    translate(
      'auto.lib.orcaCloudSession.sandboxRestarting',
      'Restarting the sandbox for {{name}}…',
      {
        name: workspaceLabel(workspaceName)
      }
    ),
    {
      id: restartToastId(workspaceId),
      ...WITHOUT_WARNING_ACTIONS,
      duration: Number.POSITIVE_INFINITY,
      description: translate(
        'auto.lib.orcaCloudSession.restartingDetail',
        'Usually under a minute. Orca resumes your agents once it is back.'
      )
    }
  )
}

function cleanupToastId(creationId: string): string {
  return `orca-cloud-cleanup:${creationId}`
}

export function showOrcaCloudCleanupStartedToast(creationId: string): void {
  toast.loading(
    translate('auto.lib.orcaCloudSession.cleaningUp', 'Cleaning up the Orca Cloud sandbox…'),
    {
      id: cleanupToastId(creationId),
      duration: Number.POSITIVE_INFINITY,
      description: translate(
        'auto.lib.orcaCloudSession.cleaningUpDetail',
        'Creation was cancelled. Deleting the sandbox so it stops using sandbox hours.'
      )
    }
  )
}

export function showOrcaCloudCleanupDoneToast(creationId: string): void {
  toast.success(translate('auto.lib.orcaCloudSession.cleanedUp', 'Orca Cloud sandbox cleaned up'), {
    id: cleanupToastId(creationId),
    duration: 6_000,
    description: translate(
      'auto.lib.orcaCloudSession.cleanedUpDetail',
      'Nothing from the cancelled workspace is left running.'
    )
  })
}

export function showOrcaCloudCleanupFailedToast(creationId: string, openServers: () => void): void {
  toast.error(
    translate(
      'auto.lib.orcaCloudSession.cleanupFailed',
      "Couldn't finish cleaning up the Orca Cloud sandbox"
    ),
    {
      id: cleanupToastId(creationId),
      duration: Number.POSITIVE_INFINITY,
      description: translate(
        'auto.lib.orcaCloudSession.cleanupFailedDetail',
        'It may still be running and using sandbox hours. Retry the cleanup from Settings.'
      ),
      action: {
        label: translate('auto.lib.orcaCloudSession.openSettings', 'Open Settings'),
        onClick: openServers
      }
    }
  )
}
