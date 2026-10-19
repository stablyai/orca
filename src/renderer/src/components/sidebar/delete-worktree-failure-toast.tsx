import { toast } from 'sonner'
import { Button } from '../ui/button'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { translate } from '@/i18n/i18n'
import { DeleteNestedWorktreesDialog } from './DeleteNestedWorktreesDialog'
import { WorktreeForceDeleteButton } from './WorktreeForceDeleteButton'
import { isNestedWorktreeRemovalError } from '../../../../shared/worktree/nested-removal'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  isLockedWorktreeRemovalError,
  SUBMODULE_DIRTY_REMOVAL_DETAIL,
  type WorktreeForceDeleteReason,
  type WorktreeRemovalTarget
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
  onAlwaysForceDelete?: () => Promise<void>
  onDeleteAnyway: () => void
  worktreeId: string
  executionHostId?: ExecutionHostId | null
  worktreeName: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  onNestedDeleted?: () => void
}

// Host-qualified: the same worktree id can exist on two hosts.
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
  toastId: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  worktreeName: string
  onNestedDeleted?: () => void
}): React.JSX.Element {
  const viewChanges = (): void => {
    toast.dismiss(toastId)
    onViewChanges()
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
  onAlwaysForceDelete,
  onDeleteAnyway,
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
  const nestedTarget =
    isNestedWorktreeRemovalError(error) && window.api?.worktrees.previewNestedRemoval
      ? nestedRemovalTarget
      : undefined

  // Why: Sonner's native action/cancel slots share the title row and squeeze
  // multi-line delete errors. Custom content gives the copy its own line.
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
        toastId={id}
        nestedRemovalTarget={nestedTarget}
        worktreeName={worktreeName}
        onNestedDeleted={onNestedDeleted}
      />
    ),
    // A toast offering a destructive choice must not expire before the user reads the reason.
    duration: canForceDelete || canWaiveArchiveHook === true || nestedTarget ? Infinity : 10000,
    dismissible: true
  })
}
