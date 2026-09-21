import { toast } from 'sonner'
import { Button } from '../ui/button'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { translate } from '@/i18n/i18n'
import {
  isLockedWorktreeRemovalError,
  type WorktreeForceDeleteReason
} from '../../../../shared/worktree/removal'

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
  onDeleteAnyway: () => void
  worktreeId: string
  worktreeName: string
}

function deleteWorktreeFailureToastId(worktreeId: string): string {
  return `delete-worktree-failure:${worktreeId}`
}

function DeleteWorktreeFailureToastBody({
  description,
  canForceDelete,
  canWaiveArchiveHook,
  showViewChanges,
  onViewChanges,
  onForceDelete,
  onDeleteAnyway,
  toastId
}: {
  description?: string
  canForceDelete: boolean
  canWaiveArchiveHook: boolean
  showViewChanges: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  onDeleteAnyway: () => void
  toastId: string
}): React.JSX.Element {
  const viewChanges = (): void => {
    toast.dismiss(toastId)
    onViewChanges()
  }
  const forceDelete = (): void => {
    toast.dismiss(toastId)
    onForceDelete()
  }
  const deleteAnyway = (): void => {
    toast.dismiss(toastId)
    onDeleteAnyway()
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {description ? (
        <p className="text-sm leading-5 text-popover-foreground/80">{description}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {showViewChanges ? (
          <Button type="button" variant="outline" size="sm" onClick={viewChanges}>
            {translate('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View')}
          </Button>
        ) : null}
        {canForceDelete ? (
          <Button type="button" variant="destructive" size="sm" onClick={forceDelete}>
            {translate('auto.components.sidebar.delete.worktree.flow.2b20ce87b3', 'Force Delete')}
          </Button>
        ) : null}
        {canWaiveArchiveHook ? (
          <Button type="button" variant="destructive" size="sm" onClick={deleteAnyway}>
            {translate(
              'auto.components.sidebar.delete.worktree.failure.archive.waiver',
              'Delete Anyway'
            )}
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
  onDeleteAnyway,
  worktreeId,
  worktreeName
}: DeleteWorktreeFailureToastOptions): void {
  const toastCopy = getDeleteWorktreeToastCopy(
    worktreeName,
    forceDeleteReason,
    error,
    lockReason ?? null
  )
  const showToast = toastCopy.isDestructive ? toast.error : toast.info
  const id = deleteWorktreeFailureToastId(worktreeId)

  // Why: Sonner's native action/cancel slots share the title row and squeeze
  // multi-line delete errors. Custom content gives the copy its own line.
  showToast(toastCopy.title, {
    id,
    description: (
      <DeleteWorktreeFailureToastBody
        description={toastCopy.description}
        canForceDelete={canForceDelete}
        canWaiveArchiveHook={canWaiveArchiveHook === true}
        showViewChanges={!isLockedWorktreeRemovalError(error) || hasKnownChanges === true}
        onViewChanges={onViewChanges}
        onForceDelete={onForceDelete}
        onDeleteAnyway={onDeleteAnyway}
        toastId={id}
      />
    ),
    // A toast offering a destructive choice must not expire before the user reads the reason.
    duration: canForceDelete || canWaiveArchiveHook === true ? Infinity : 10000,
    dismissible: true
  })
}
