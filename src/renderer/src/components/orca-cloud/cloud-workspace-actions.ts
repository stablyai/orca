// User actions on an Orca Cloud workspace, with their toasts. Archive reuses the ordinary Sleep
// flow (terminals and chats saved first) after a short undo window; unarchive and Wake reuse the
// ordinary open-and-wake path, so every wake shows the same "Waking…" overlay.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runSleepWorktreeVerified } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  unarchiveCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-actions'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { describeCloudActionFailure, failureToast } from './cloud-action-failure'
import {
  isCloudWorkspaceDeleting,
  registerQueuedCloudArchive
} from '@/lib/orca-cloud/pending-cloud-archive'
import { cloudSyncRemovalPreview } from '@/lib/orca-cloud/cloud-sync-store'
import { useAppStore } from '@/store'
import { runArchiveNow } from './cloud-archive-now-flow'
import { getOptimisticArchive } from '@/lib/orca-cloud/optimistic-cloud-archive'
import { archiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { DEFAULT_ARCHIVE_TTL_DAYS } from './archive-snapshot-copy'
import {
  cloudWorkspaceTarget,
  getCloudWorkspaceSnapshot,
  updateCloudWorkspaceSnapshot
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  askArchiveAnywayAfterHookFailure,
  cloudArchiveHookNeedsWake,
  runCloudArchiveHook
} from './cloud-archive-hook-flow'

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
      confirmLabel: translate('orcaCloudWorkspace.restart', 'Restart')
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

const ARCHIVE_UNDO_MS = 5_000

/** Its VM is stopped: the control plane says asleep, or this computer's record is suspended. */
function isCloudWorkspaceAlreadyAsleep(workspaceId: string): boolean {
  const state = getCloudWorkspaceSnapshot().status[workspaceId]?.status?.state
  return (
    state === 'sleeping' ||
    useAppStore.getState().ephemeralVmRuntimesByWorkspaceId?.[workspaceId]?.status === 'suspended'
  )
}

function archiveFailedTitle(name: string | null | undefined): string {
  return name
    ? translate('orcaCloudWorkspace.archiveFailedNamed', 'Couldn’t archive {{name}}', { name })
    : translate('orcaCloudWorkspace.archiveFailed', 'Couldn’t archive the workspace')
}

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
    /** It sleeps and will be woken for its archive hook; the toast offers Skip. */
    onSkipHookWake?: () => void
  }
): Promise<boolean> {
  // Single-flight per workspace: a second Archive in the window joins the first, so its Undo (and
  // Delete's cancel) reaches the one timer instead of only the latest of two.
  const queued = queuedArchives.get(key)
  if (queued) {
    return queued
  }
  const run = startArchiveWithUndo(key, options).finally(() => {
    queuedArchives.delete(key)
    clearQueuedArchivePending(key)
  })
  queuedArchives.set(key, run)
  // Archive greys on every surface while it's queued (`pending` is what they read).
  if (!key.startsWith('home:')) {
    updateCloudWorkspaceSnapshot((s) => ({ pending: { ...s.pending, [key]: 'archive' } }))
  }
  return run
}

const queuedArchives = new Map<string, Promise<boolean>>()

function clearQueuedArchivePending(key: string): void {
  updateCloudWorkspaceSnapshot((s) => {
    if (s.pending[key] !== 'archive') {
      return {}
    }
    const pending = { ...s.pending }
    delete pending[key]
    return { pending }
  })
}

function startArchiveWithUndo(
  key: string,
  options: Parameters<typeof runArchiveWithUndo>[1]
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
        // A Delete of the same row since Archive was pressed makes this failure expected.
        if (options.reportFailure?.() ?? !isCloudWorkspaceDeleting(key)) {
          failureToast(archiveFailedTitle(options.name), result)
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
    isCloudWorkspaceDeleting(id)
      ? Promise.resolve()
      : // Already asleep: nothing to stop, and the sleep can't reach its server (it would report
        // "not slept" and the archive would never run). The control plane archives it as is.
        isCloudWorkspaceAlreadyAsleep(id)
        ? Promise.resolve([{ completed: true }])
        : runSleepWorktreeVerified(id).then((completed) => [{ completed }])
  const target = cloudWorkspaceTarget(workspaceId)
  const [localCopy, hookNeedsWake] = await Promise.all([
    cloudSyncRemovalPreview(workspaceId).catch(() => undefined),
    cloudArchiveHookNeedsWake(target)
  ])
  // A Delete that started while the preview was read found no queued archive to cancel yet:
  // the workspace is going away, so this archive never queues.
  if (isCloudWorkspaceDeleting(workspaceId)) {
    return
  }
  if (useAppStore.getState().activeWorktreeId === workspaceId) {
    // In front: the archived page shows at once and carries the undo, hook and failure inline.
    await runArchiveNow(workspaceId, {
      undoMs: options.undoMs ?? ARCHIVE_UNDO_MS,
      hookNeedsWake,
      ...(localCopy ? { localCopy } : {}),
      runHook: async (wake) => {
        const outcome = await runCloudArchiveHook(workspaceId, {
          name: options.name,
          wake,
          target,
          quiet: true
        })
        return outcome.kind === 'failed' ? outcome.result : null
      },
      commit: (beforeSleep) => archiveCloudWorkspace(workspaceId, { sleep, beforeSleep }),
      reportFailure: () => !isCloudWorkspaceDeleting(workspaceId),
      describeFailure: describeCloudActionFailure,
      inFront: () => useAppStore.getState().activeWorktreeId === workspaceId,
      toastFailure: (result) => failureToast(archiveFailedTitle(options.name), result)
    })
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
  // Archive was just pressed and nothing has run yet: Unarchive anywhere is its Undo, so the
  // queued archive can't override it when the window ends.
  const optimistic = getOptimisticArchive(workspaceId)
  if (optimistic?.phase === 'undo') {
    optimistic.undo()
    return true
  }
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
