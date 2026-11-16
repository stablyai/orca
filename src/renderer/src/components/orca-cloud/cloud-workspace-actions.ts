// User actions on an Orca Cloud workspace, with their toasts. Archive reuses the ordinary Sleep
// flow (terminals and chats saved first) after a short undo window; unarchive and Wake reuse the
// ordinary open-and-wake path, so every wake shows the same "Waking…" overlay.
import { classifyEntitlementDenial } from '../../../../shared/orca-billing'
import { getBillingSummary } from '../billing/billing-summary-store'
import { describeError } from '../cloud-workspaces/cloud-workspace-errors'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { openPlansDialog } from '@/components/billing/plans/plans-dialog-store'
import { signInAgainMessage } from '@/lib/orca-cloud/orca-sign-in-again'
import { signInAgainToastAction } from '@/lib/orca-cloud/orca-sign-in-again-action'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  unarchiveCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-actions'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import {
  isCloudWorkspaceDeleting,
  registerQueuedCloudArchive
} from '@/lib/orca-cloud/pending-cloud-archive'
import { cloudSyncRemovalPreview } from '@/lib/orca-cloud/cloud-sync-store'
import { archiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { DEFAULT_ARCHIVE_TTL_DAYS } from './archive-snapshot-copy'
import { cloudWorkspaceTarget } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  askArchiveAnywayAfterHookFailure,
  cloudArchiveHookNeedsWake,
  runCloudArchiveHook
} from './cloud-archive-hook-flow'

/** Codes map to plain copy; raw control-plane messages never reach a toast. */
function failureToast(title: string, result: CloudWorkspaceResult<null>): void {
  if (result.ok) {
    return
  }
  if (result.code === 'entitlement_denied') {
    // The shared classifier: the actual reason (plan, hours, spend cap, payment, limits), and
    // "Compare plans" only where buying fixes it and only for people who can (owner or admin).
    const denial = classifyEntitlementDenial(result.reason)
    const canFixWithPlans =
      (denial === 'plan' || denial === 'hours') && getBillingSummary().canManageBilling
    toast.error(title, {
      description: describeError('entitlement_denied', result.reason ?? undefined),
      ...(canFixWithPlans
        ? {
            action: {
              label: translate('auto.components.billing.comparePlans', 'Compare plans'),
              onClick: () => openPlansDialog()
            }
          }
        : {})
    })
    return
  }
  if (result.userMessage) {
    toast.error(title, { description: result.userMessage })
    return
  }
  if (result.code === 'unauthorized') {
    toast.error(title, { description: signInAgainMessage(), action: signInAgainToastAction() })
    return
  }
  toast.error(title, {
    description:
      result.code === 'unavailable'
        ? translate(
            'orcaCloudWorkspace.error.unavailable',
            'Orca Cloud isn’t reachable right now. Try again in a moment.'
          )
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
      title: translate('orcaCloudWorkspace.restartConfirmTitle', 'Restart workspace?'),
      description: translate(
        'orcaCloudWorkspace.restartConfirm',
        'Running agents stop and resume after the restart. Your files are kept.'
      ),
      confirmLabel: translate('orcaCloudWorkspace.restart', 'Restart'),
      icon: RotateCw
    })
    if (!ok) {
      return
    }
  }
  const result = await restartCloudWorkspace(workspaceId)
  failureToast(
    translate('orcaCloudWorkspace.restartFailed', 'Couldn’t restart the workspace'),
    result
  )
  if (result.ok) {
    toast.success(translate('orcaCloudWorkspace.restarted', 'Workspace restarted'), {
      description: translate(
        'orcaCloudWorkspace.restartedDetail',
        'Orca resumes your agents after the restart.'
      )
    })
  }
}

export const ARCHIVE_UNDO_MS = 5_000

/**
 * Archive with a real undo: nothing happens for 5 s while the toast offers Undo; then `commit`
 * runs. Used by the sidebar (sleep → archive) and the team list (control-plane archive).
 */
export function runArchiveWithUndo(
  key: string,
  options: {
    name?: string | null
    undoMs?: number
    commit: () => Promise<CloudWorkspaceResult<null>>
    /** False while the workspace is being deleted: its failure is not worth a toast. */
    reportFailure?: () => boolean
    /** The copy synced to this computer, which goes with the archive (said in the toast). */
    localCopy?: { hasLocalCopy: boolean; editedHere: number }
    /** ARCHIVE-HOOK: it sleeps and will be woken for its archive hook; the toast offers Skip. */
    onSkipHookWake?: () => void
  }
): Promise<boolean> {
  return new Promise((resolve) => {
    let undone = false
    const toastId = `orca-cloud-archive:${key}`
    const cancel = (): void => {
      undone = true
      clearTimeout(commit)
      toast.dismiss(toastId)
      unregister()
      resolve(false)
    }
    const commit = setTimeout(() => {
      unregister()
      toast.dismiss(toastId)
      if (undone) {
        resolve(false)
        return
      }
      void options.commit().then((result) => {
        if (options.reportFailure?.() ?? true) {
          failureToast(
            options.name
              ? translate('orcaCloudWorkspace.archiveFailedNamed', 'Couldn’t archive {{name}}', {
                  name: options.name
                })
              : translate('orcaCloudWorkspace.archiveFailed', 'Couldn’t archive the workspace'),
            result
          )
        }
        resolve(result.ok)
      })
    }, options.undoMs ?? ARCHIVE_UNDO_MS)
    const unregister = registerQueuedCloudArchive(key, cancel)
    const undoMs = options.undoMs ?? ARCHIVE_UNDO_MS
    const shownAt = Date.now()
    const show = (askHookWake: boolean): void => {
      toast(
        options.name
          ? translate('orcaCloudWorkspace.archivedNamed', 'Archived {{name}}', {
              name: options.name
            })
          : translate('orcaCloudWorkspace.archivedWorkspace', 'Archived the workspace'),
        {
          id: toastId,
          duration: Math.max(1, undoMs - (Date.now() - shownAt)),
          description: askHookWake
            ? `${archivedDetail(options.localCopy)} ${translate(
                'orcaCloudWorkspace.archiveHook.wakeFirst',
                'It wakes first to run the archive script in orca.yaml.'
              )}`
            : archivedDetail(options.localCopy),
          action: {
            label: translate('orcaCloudWorkspace.undo', 'Undo'),
            onClick: cancel
          },
          ...(askHookWake
            ? {
                cancel: {
                  label: translate('orcaCloudWorkspace.archiveHook.skip', 'Skip script'),
                  onClick: () => {
                    options.onSkipHookWake?.()
                    // Keep Undo for the rest of the window.
                    setTimeout(() => !undone && show(false), 0)
                  }
                }
              }
            : {})
        }
      )
    }
    show(options.onSkipHookWake !== undefined)
  })
}

function archivedDetail(localCopy?: { hasLocalCopy: boolean; editedHere: number }): string {
  // Same retention words as the Archive tooltip and dialog.
  const count = archiveTtlDays() ?? DEFAULT_ARCHIVE_TTL_DAYS
  if (localCopy?.editedHere) {
    return translate(
      'orcaCloudWorkspace.archivedDetailLocalEdits',
      'Kept for {{days}} days, then deleted. {{count}} changed files on this computer will be removed.',
      {
        count: localCopy.editedHere,
        days: count,
        defaultValue_one:
          'Kept for {{days}} days, then deleted. {{count}} changed file on this computer will be removed.'
      }
    )
  }
  if (localCopy?.hasLocalCopy) {
    return translate(
      'orcaCloudWorkspace.archivedDetailLocalCopy',
      'Kept for {{count}} days, then deleted. The copy on this computer will be removed.',
      {
        count,
        defaultValue_one:
          'Kept for {{count}} day, then deleted. The copy on this computer will be removed.'
      }
    )
  }
  return translate('orcaCloudWorkspace.archivedDetail', 'Kept for {{count}} days, then deleted.', {
    count,
    defaultValue_one: 'Kept for {{count}} day, then deleted.'
  })
}

/** Sidebar archive: the ordinary Sleep, then the control-plane archive, behind the Undo toast. */
export async function runArchiveCloudWorkspace(
  workspaceId: string,
  options: { name?: string | null; undoMs?: number } = {}
): Promise<void> {
  // A Delete that starts while this runs destroys the sandbox; its sleep and archive then fail
  // for a workspace that is going away, which is not worth an error toast.
  const sleep = (id: string): Promise<readonly { completed: boolean }[] | void> =>
    isCloudWorkspaceDeleting(id) ? Promise.resolve() : runSleepWorktree(id)
  const target = cloudWorkspaceTarget(workspaceId)
  const [localCopy, hookNeedsWake] = await Promise.all([
    cloudSyncRemovalPreview(workspaceId).catch(() => undefined),
    cloudArchiveHookNeedsWake(target)
  ])
  // A Delete that started while the preview was read found no queued archive to cancel yet:
  // the workspace is going away, so this archive never queues (INT-T1).
  if (isCloudWorkspaceDeleting(workspaceId)) {
    return
  }
  let skipHook = false
  const beforeSleep = async (): Promise<boolean> => {
    if (skipHook) {
      console.warn('[orca-cloud] archive hook skipped by the user (asleep)', { workspaceId })
      return true
    }
    const outcome = await runCloudArchiveHook(workspaceId, {
      name: options.name,
      wake: hookNeedsWake,
      target
    })
    if (outcome.kind === 'proceed') {
      return true
    }
    return askArchiveAnywayAfterHookFailure(workspaceId, outcome.result, options.name)
  }
  await runArchiveWithUndo(workspaceId, {
    ...options,
    ...(localCopy ? { localCopy } : {}),
    ...(hookNeedsWake ? { onSkipHookWake: () => (skipHook = true) } : {}),
    commit: () => archiveCloudWorkspace(workspaceId, { sleep, beforeSleep }),
    reportFailure: () => !isCloudWorkspaceDeleting(workspaceId)
  })
}

/** Resolves true once unarchived and woken; a failure has already shown its toast. */
export async function runUnarchiveCloudWorkspace(workspaceId: string): Promise<boolean> {
  const result = await unarchiveCloudWorkspace(workspaceId, {
    wake: (id) => activateWorktreeFromSidebar(id)
  })
  failureToast(
    translate('orcaCloudWorkspace.unarchiveFailed', 'Couldn’t unarchive the workspace'),
    result
  )
  return result.ok
}

export async function wakeCloudWorkspace(workspaceId: string): Promise<void> {
  await activateWorktreeFromSidebar(workspaceId)
}
