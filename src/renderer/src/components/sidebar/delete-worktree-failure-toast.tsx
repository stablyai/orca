import { toast } from 'sonner'
import { Button } from '../ui/button'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { translate } from '@/i18n/i18n'
import {
  isLockedWorktreeRemovalError,
  type WorktreeForceDeleteReason
} from '../../../../shared/worktree-removal'

type DeleteWorktreeFailureToastOptions = {
  error: string
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
  lockReason?: string | null
  hasKnownChanges?: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  worktreeId: string
  worktreeName: string
}

function deleteWorktreeFailureToastId(worktreeId: string): string {
  return `delete-worktree-failure:${worktreeId}`
}

function DeleteWorktreeFailureToastBody({
  description,
  canForceDelete,
  showViewChanges,
  onViewChanges,
  onForceDelete,
  toastId
}: {
  description?: string
  canForceDelete: boolean
  showViewChanges: boolean
  onViewChanges: () => void
  onForceDelete: () => void
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
  onViewChanges,
  onForceDelete,
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
        showViewChanges={!isLockedWorktreeRemovalError(error) || hasKnownChanges === true}
        onViewChanges={onViewChanges}
        onForceDelete={onForceDelete}
        toastId={id}
      />
    ),
    duration: canForceDelete ? Infinity : 10000,
    dismissible: true
  })
}
