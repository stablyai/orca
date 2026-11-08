// @protected-copy: delete-workspace confirmation buttons.
import type { JSX, Ref } from 'react'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { WorktreeForceDeleteButton } from './WorktreeForceDeleteButton'
import { deleteWorkspacesCountLabel } from '../context-menu/workspace-batch-action-labels'

export function DeleteWorktreeDialogFooter({
  isMainWorktree,
  isDeleting,
  isDetachingChildren = false,
  deleteDisabled = false,
  canForceDelete,
  isBatchDelete,
  worktreeCount,
  canDeleteAllLineage,
  lineageDeleteTargetCount,
  onCancel,
  onForceDelete,
  onSavingChange,
  onDelete,
  onAlwaysDelete,
  confirmButtonRef
}: {
  isMainWorktree: boolean
  isDeleting: boolean
  isDetachingChildren?: boolean
  deleteDisabled?: boolean
  canForceDelete: boolean
  isBatchDelete: boolean
  worktreeCount: number
  canDeleteAllLineage: boolean
  lineageDeleteTargetCount: number
  onCancel: () => void
  onForceDelete: () => void
  onSavingChange: (saving: boolean) => void
  onDelete: () => void
  /** Saves the skip-confirmation preference; omitted where skipping is not allowed. */
  onAlwaysDelete?: () => Promise<void>
  confirmButtonRef: Ref<HTMLButtonElement>
}): JSX.Element {
  const t = useTranslate()
  const label = isDetachingChildren
    ? t('worktree.delete.detachingChildren', 'Detaching children...')
    : isDeleting
      ? canForceDelete
        ? t('auto.components.sidebar.DeleteWorktreeDialogFooter.forceDeleting', 'Force Deleting...')
        : t('auto.components.sidebar.DeleteWorktreeDialogFooter.deleting', 'Deleting...')
      : isBatchDelete
        ? deleteWorkspacesCountLabel(worktreeCount, t)
        : canDeleteAllLineage
          ? deleteWorkspacesCountLabel(lineageDeleteTargetCount, t)
          : canForceDelete
            ? t('auto.components.sidebar.DeleteWorktreeDialogFooter.forceDelete', 'Force Delete')
            : t(
                'auto.components.sidebar.DeleteWorktreeDialogFooter.deleteWorkspace',
                'Delete Workspace'
              )

  return (
    <>
      <Button variant="outline" onClick={onCancel} disabled={isDeleting}>
        {isMainWorktree
          ? t('auto.components.sidebar.DeleteWorktreeDialogFooter.cf95e3b5bb', 'Close')
          : t('auto.components.sidebar.DeleteWorktreeDialogFooter.c0e972d726', 'Cancel')}
      </Button>
      {!isMainWorktree && canForceDelete ? (
        <WorktreeForceDeleteButton
          buttonRef={confirmButtonRef}
          size="default"
          disabled={isDeleting || deleteDisabled}
          onForceDelete={onForceDelete}
          onSavingChange={onSavingChange}
          onAlwaysForceDelete={() =>
            useAppStore.getState().updateSettingsOrThrow({ alwaysForceDeleteWorktrees: true })
          }
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </WorktreeForceDeleteButton>
      ) : !isMainWorktree && onAlwaysDelete ? (
        <WorktreeForceDeleteButton
          buttonRef={confirmButtonRef}
          size="default"
          disabled={isDeleting || deleteDisabled}
          onForceDelete={onDelete}
          onSavingChange={onSavingChange}
          onAlwaysForceDelete={onAlwaysDelete}
          moreActionsLabel={t('workspaceDeletion.moreDeleteOptions', 'More delete options')}
          alwaysForceDeleteLabel={t('workspaceDeletion.alwaysDelete', 'Always delete')}
          alwaysForceDeleteTooltip={t(
            'workspaceDeletion.alwaysDeleteTooltip',
            'Skip this confirmation for future deletions.'
          )}
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </WorktreeForceDeleteButton>
      ) : !isMainWorktree ? (
        <Button
          ref={confirmButtonRef}
          variant="destructive"
          onClick={onDelete}
          disabled={isDeleting || deleteDisabled}
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </Button>
      ) : null}
    </>
  )
}
