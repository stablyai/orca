import { toast } from 'sonner'
import { Button } from '../../../ui/button'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { useTranslate } from '@/i18n/use-translate'
import { DeleteNestedWorktreesDialog } from './DeleteNestedWorktreesDialog'
import { WorktreeForceDeleteButton } from './WorktreeForceDeleteButton'
import { isNestedWorktreeRemovalError } from '../../../../../../shared/worktree/nested-removal'
import { isCloudDeleteNotSentError } from '../../../../../../shared/recipe-host-removal'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  isLockedWorktreeRemovalError,
  SUBMODULE_DIRTY_REMOVAL_DETAIL,
  type WorktreeForceDeleteReason,
  type WorktreeRemovalTarget
} from '../../../../../../shared/worktree/removal'

type DeleteWorktreeFailureToastOptions = {
  error: string
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
  lockReason?: string | null
  hasKnownChanges?: boolean
  /** The archive hook refused this removal, so the user may waive it (#19334). */
  canWaiveArchiveHook?: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
  onDeleteAnyway: () => void
  /** REG-12: a delete that failed before any sandbox delete was sent offers Try again. */
  onRetry?: () => void
  worktreeId: string
  executionHostId?: ExecutionHostId | null
  worktreeName: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  onNestedDeleted?: () => void
}

// Qualify toast IDs by host because worktree IDs may repeat across machines.
function deleteWorktreeFailureToastId(target: WorktreeRemovalTarget): string {
  return `delete-worktree-failure:${composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id)}`
}

/** A workspace deleted from another surface must not keep a toast offering to delete it. */
export function dismissDeleteWorktreeFailureToast(target: WorktreeRemovalTarget): void {
  toast.dismiss(deleteWorktreeFailureToastId(target))
}

function DeleteWorktreeFailureToastBody({
  description,
  canForceDelete,
  canWaiveArchiveHook,
  showViewChanges,
  onViewChanges,
  onForceDelete,
  onAlwaysForceDelete,
  onDeleteAnyway,
  onRetry,
  toastId,
  nestedRemovalTarget,
  worktreeName,
  onNestedDeleted
}: {
  description?: string
  canForceDelete: boolean
  canWaiveArchiveHook: boolean
  showViewChanges: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
  onDeleteAnyway: () => void
  onRetry?: () => void
  toastId: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  worktreeName: string
  onNestedDeleted?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const viewChanges = (): void => {
    toast.dismiss(toastId)
    onViewChanges()
  }
  const deleteAnyway = (): void => {
    toast.dismiss(toastId)
    onDeleteAnyway()
  }
  const retry = (): void => {
    toast.dismiss(toastId)
    onRetry?.()
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {description ? (
        <p className="text-sm leading-5 text-popover-foreground/80">{description}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {showViewChanges ? (
          <Button type="button" variant="outline" size="sm" onClick={viewChanges}>
            {t('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View')}
          </Button>
        ) : null}
        {nestedRemovalTarget ? (
          <DeleteNestedWorktreesDialog
            target={nestedRemovalTarget}
            worktreeName={worktreeName}
            onDeleted={onNestedDeleted}
            dismissToast={() => toast.dismiss(toastId)}
          />
        ) : null}
        {canForceDelete ? (
          <WorktreeForceDeleteButton
            toastId={toastId}
            onForceDelete={onForceDelete}
            onAlwaysForceDelete={onAlwaysForceDelete}
          />
        ) : null}
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t('auto.components.sidebar.delete.worktree.failure.tryAgain', 'Try again')}
          </Button>
        ) : null}
        {canWaiveArchiveHook ? (
          <Button type="button" variant="destructive" size="sm" onClick={deleteAnyway}>
            {t('auto.components.sidebar.delete.worktree.failure.archive.waiver', 'Delete Anyway')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function showDeleteWorktreeFailureToast({
  error,
  canForceDelete,
  forceDeleteReason,
  lockReason,
  hasKnownChanges,
  canWaiveArchiveHook,
  onViewChanges,
  onForceDelete,
  onAlwaysForceDelete,
  onDeleteAnyway,
  onRetry,
  worktreeId,
  executionHostId,
  worktreeName,
  nestedRemovalTarget,
  onNestedDeleted
}: DeleteWorktreeFailureToastOptions): void {
  const toastCopy = getDeleteWorktreeToastCopy(
    worktreeName,
    forceDeleteReason,
    error,
    lockReason ?? null
  )
  const showToast = toastCopy.isDestructive ? toast.error : toast.info
  const id = deleteWorktreeFailureToastId({
    id: worktreeId,
    executionHostId: executionHostId ?? null
  })
  const nestedTarget = isNestedWorktreeRemovalError(error) ? nestedRemovalTarget : undefined
  // Only where nothing was destroyed yet: then trying again is safe (REG-12).
  const retryable = onRetry && isCloudDeleteNotSentError(error) ? onRetry : undefined

  // Custom content gives multiline errors their own line instead of squeezing them into Sonner’s action/title row.
  showToast(toastCopy.title, {
    id,
    description: (
      <DeleteWorktreeFailureToastBody
        description={toastCopy.description}
        canForceDelete={canForceDelete}
        canWaiveArchiveHook={canWaiveArchiveHook === true}
        showViewChanges={
          !(
            isLockedWorktreeRemovalError(error) ||
            (forceDeleteReason === 'submodules' && !error.includes(SUBMODULE_DIRTY_REMOVAL_DETAIL))
          ) || hasKnownChanges === true
        }
        onViewChanges={onViewChanges}
        onForceDelete={onForceDelete}
        onAlwaysForceDelete={onAlwaysForceDelete}
        onDeleteAnyway={onDeleteAnyway}
        onRetry={retryable}
        toastId={id}
        nestedRemovalTarget={nestedTarget}
        worktreeName={worktreeName}
        onNestedDeleted={onNestedDeleted}
      />
    ),
    // A toast offering a destructive choice must not expire before the user reads the reason.
    duration:
      canForceDelete || canWaiveArchiveHook === true || nestedTarget || retryable
        ? Infinity
        : 10000,
    dismissible: true
  })
}
