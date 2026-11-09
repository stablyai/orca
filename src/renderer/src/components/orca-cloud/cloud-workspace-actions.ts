// User actions on an Orca Cloud workspace, with their toasts. Archive reuses the ordinary Sleep
// flow (terminals and chats saved first) after a short undo window; unarchive and Wake reuse the
// ordinary open-and-wake path, so every wake shows the same "Waking…" overlay.
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  unarchiveCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-actions'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** Codes map to plain copy; raw control-plane messages never reach a toast. */
function failureToast(title: string, result: CloudWorkspaceResult<null>): void {
  if (result.ok) {
    return
  }
  if (result.code === 'entitlement_denied') {
    toast.error(title, {
      description: translate(
        'orcaCloudWorkspace.error.noHours',
        'You’re out of sandbox hours. Your files are safe.'
      ),
      action: {
        label: translate('orcaCloudWorkspace.error.seePlans', 'See plans'),
        onClick: () => openPlansPage('sandbox')
      }
    })
    return
  }
  toast.error(title, {
    description:
      result.code === 'unavailable'
        ? translate(
            'orcaCloudWorkspace.error.unavailable',
            'Orca Cloud isn’t reachable right now. Try again in a moment.'
          )
        : result.code === 'unauthorized'
          ? translate('orcaCloudWorkspace.error.signIn', 'Sign in to Orca again, then try again.')
          : translate('orcaCloudWorkspace.error.generic', 'Something went wrong. Try again.')
  })
}

/** Restart asks first when agents are working there; they stop and Orca resumes them after. */
export async function runRestartCloudWorkspace(
  workspaceId: string,
  options: { agentsRunning?: boolean; confirm?: ConfirmationDialogContextValue | null } = {}
): Promise<void> {
  if (options.agentsRunning && options.confirm) {
    const ok = await options.confirm({
      title: translate('orcaCloudWorkspace.restartConfirmTitle', 'Restart sandbox?'),
      description: translate(
        'orcaCloudWorkspace.restartConfirm',
        'Running agents stop and resume after the restart. Your files are kept.'
      ),
      confirmLabel: translate('orcaCloudWorkspace.restartSandbox', 'Restart sandbox'),
      icon: RotateCw
    })
    if (!ok) {
      return
    }
  }
  const result = await restartCloudWorkspace(workspaceId)
  failureToast(
    translate('orcaCloudWorkspace.restartFailed', 'Couldn’t restart the sandbox'),
    result
  )
  if (result.ok) {
    toast.success(translate('orcaCloudWorkspace.restarted', 'Sandbox restarted'), {
      description: translate(
        'orcaCloudWorkspace.restartedDetail',
        'Orca resumes your agents after the restart.'
      )
    })
  }
}

export const ARCHIVE_UNDO_MS = 5_000

/**
 * Archive with a real undo: nothing happens for 5 s while the toast offers Undo; then the
 * workspace sleeps and is archived.
 */
export function runArchiveCloudWorkspace(
  workspaceId: string,
  options: { name?: string | null; undoMs?: number } = {}
): Promise<void> {
  return new Promise((resolve) => {
    let undone = false
    const toastId = `orca-cloud-archive:${workspaceId}`
    const commit = setTimeout(() => {
      toast.dismiss(toastId)
      if (undone) {
        resolve()
        return
      }
      void archiveCloudWorkspace(workspaceId, { sleep: runSleepWorktree }).then((result) => {
        failureToast(
          translate('orcaCloudWorkspace.archiveFailed', 'Couldn’t archive the workspace'),
          result
        )
        resolve()
      })
    }, options.undoMs ?? ARCHIVE_UNDO_MS)
    toast(
      options.name
        ? translate('orcaCloudWorkspace.archivingNamed', 'Archiving {{name}}…', { name: options.name })
        : translate('orcaCloudWorkspace.archiving', 'Archiving workspace…'),
      {
        id: toastId,
        duration: options.undoMs ?? ARCHIVE_UNDO_MS,
        description: translate(
          'orcaCloudWorkspace.archivingDetail',
          'It stops and stays browsable: PRs, last changes and files.'
        ),
        action: {
          label: translate('orcaCloudWorkspace.undo', 'Undo'),
          onClick: () => {
            undone = true
            clearTimeout(commit)
            resolve()
          }
        }
      }
    )
  })
}

export async function runUnarchiveCloudWorkspace(workspaceId: string): Promise<void> {
  const result = await unarchiveCloudWorkspace(workspaceId, {
    wake: (id) => activateWorktreeFromSidebar(id)
  })
  failureToast(
    translate('orcaCloudWorkspace.unarchiveFailed', 'Couldn’t unarchive the workspace'),
    result
  )
}

export function wakeCloudWorkspace(workspaceId: string): Promise<void> {
  return activateWorktreeFromSidebar(workspaceId)
}
