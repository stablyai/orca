// "Apply changes again" for "Move to this computer": re-applies a move's saved changes onto the SAME
// local worktree after a partial or failed apply, and offers it again after an app restart.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { noteCloudWorkspaceMoved, setCloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudTransferPrepared } from '../../../shared/hosted-sandbox/cloud-transfer-api'
import { claimMoveRun, releaseMoveRun } from '@/lib/orca-cloud/orca-cloud-move-run'

/**
 * "Apply changes again": re-applies the saved changes and chats onto the SAME local worktree after
 * a partial or failed apply (never creates another one). Main skips what is already there and never
 * forces a patch over edits made here since; whatever still conflicts stays saved and is reported.
 */
export async function reapplyOrcaCloudTransfer(args: {
  workspaceId: string
  name: string
  localWorktreeId: string
  prepared: CloudTransferPrepared
  worktreePath: string
  archiveAfter: boolean
  /** Archives the cloud workspace once everything applied (when archiveAfter). */
  onArchive?: (workspaceId: string, name: string) => void
}): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  if (!api) {
    return
  }
  const run = claimMoveRun()
  if (run === null) {
    return
  }
  const startedAt = Date.now()
  const base = { workspaceId: args.workspaceId, name: args.name, archiveAfter: args.archiveAfter }
  setCloudMoveState({
    ...base,
    stage: 'running',
    step: 'applying',
    skipped: ['waking', 'packing', 'downloading', 'creating'],
    startedAt,
    bytes: null,
    totalBytes: null,
    cancel: null,
    minimized: false
  })
  try {
    const result = await api.reapplyTransferToLocal({
      transferId: args.prepared.transferId,
      worktreePath: args.worktreePath
    })
    if (!result.ok) {
      throw new Error(result.message)
    }
    noteCloudWorkspaceMoved(args.workspaceId, Date.now(), args.localWorktreeId)
    // The archive was held back only while something was left to apply.
    const archiveNow = args.archiveAfter && !result.value.leftoverPatchDir
    setCloudMoveState({
      stage: 'done',
      workspaceId: args.workspaceId,
      name: args.name,
      localWorktreeId: args.localWorktreeId,
      prepared: args.prepared,
      finished: result.value,
      elapsedMs: Date.now() - startedAt,
      archivedAfter: archiveNow,
      archiveAfter: args.archiveAfter,
      minimized: false
    })
    if (archiveNow) {
      args.onArchive?.(args.workspaceId, args.name)
    }
  } catch (error) {
    console.error('[orca-cloud] apply changes again failed', error)
    setCloudMoveState({
      ...base,
      stage: 'failed',
      step: 'applying',
      timedOut: false,
      reason: null,
      retryable: true,
      restored: null,
      localWorktreeId: args.localWorktreeId,
      retry: { prepared: args.prepared, worktreePath: args.worktreePath },
      minimized: false
    })
  } finally {
    releaseMoveRun(run)
  }
}

/** Asks once more before deleting a move's saved changes, then deletes them. */
function confirmDiscardPendingTransfer(transferId: string): void {
  toast.warning(translate('orcaCloudMove.pending.discardConfirm', 'Delete the saved changes?'), {
    id: `orca-cloud-move-discard-${transferId}`,
    description: translate(
      'orcaCloudMove.pending.discardDetail',
      'This can’t be undone. They may be the only copy.'
    ),
    duration: Infinity,
    cancel: { label: translate('orcaCloudMove.pending.keep', 'Keep'), onClick: () => undefined },
    action: {
      label: translate('orcaCloudMove.pending.delete', 'Delete'),
      onClick: () => void window.api?.orcaCloudWorkspace?.discardPendingTransfer({ transferId })
    }
  })
}

/**
 * After an app restart: moves whose changes were not all applied are kept on disk. Offer
 * "Apply changes again" for each (same local worktree; never a new one).
 */
export async function offerPendingCloudTransfers(): Promise<number> {
  const api = window.api?.orcaCloudWorkspace
  if (!api) {
    return 0
  }
  const pending = await api.listPendingTransfers().catch(() => [])
  for (const transfer of pending) {
    toast.warning(
      translate('orcaCloudMove.pending.title', 'Some changes from a move weren’t applied'),
      {
        id: `orca-cloud-move-pending-${transfer.transferId}`,
        description: translate(
          'orcaCloudMove.pending.detail',
          'They are saved on this computer. Nothing you changed here is overwritten.'
        ),
        duration: Infinity,
        // Two steps: these saved changes may be the only copy (the cloud one may be archived).
        cancel: {
          label: translate('orcaCloudMove.pending.discard', 'Discard'),
          onClick: () => confirmDiscardPendingTransfer(transfer.transferId)
        },
        action: {
          label: translate('orcaCloudMove.reapply', 'Apply changes again'),
          onClick: () =>
            void api
              .reapplyTransferToLocal({
                transferId: transfer.transferId,
                worktreePath: transfer.worktreePath
              })
              .then((result) => {
                if (!result.ok) {
                  toast.error(result.message)
                } else if (result.value.leftoverPatchDir) {
                  toast.warning(
                    translate(
                      'orcaCloudMove.pending.stillLeft',
                      'Some changes still conflict with edits made here. They stay saved.'
                    )
                  )
                } else {
                  toast.success(translate('orcaCloudMove.pending.done', 'All changes applied'))
                }
              })
        }
      }
    )
  }
  return pending.length
}
