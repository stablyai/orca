import type { JSX, Ref } from 'react'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { WorktreeForceDeleteButton } from './WorktreeForceDeleteButton'

export function DeleteWorktreeDialogFooter({
  isMainWorktree,
  isDeleting,
  canForceDelete,
  isBatchDelete,
  worktreeCount,
  canDeleteAllLineage,
  lineageDeleteTargetCount,
  onCancel,
  onForceDelete,
  onSavingChange,
  onDelete,
  confirmButtonRef
}: {
  isMainWorktree: boolean
  isDeleting: boolean
  canForceDelete: boolean
  isBatchDelete: boolean
  worktreeCount: number
  canDeleteAllLineage: boolean
  lineageDeleteTargetCount: number
  onCancel: () => void
  onForceDelete: () => void
  onSavingChange: (saving: boolean) => void
  onDelete: () => void
  confirmButtonRef: Ref<HTMLButtonElement>
}): JSX.Element {
  const label = isDeleting
    ? canForceDelete
      ? 'Force Deleting...'
      : 'Deleting...'
    : isBatchDelete
      ? `Delete ${worktreeCount} Workspaces`
      : canDeleteAllLineage
        ? `Delete ${lineageDeleteTargetCount} Workspaces`
        : canForceDelete
          ? 'Force Delete'
          : 'Delete Workspace'

  return (
    <>
      <Button variant="outline" onClick={onCancel} disabled={isDeleting}>
        {isMainWorktree
          ? translate('auto.components.sidebar.DeleteWorktreeDialogFooter.cf95e3b5bb', 'Close')
          : translate('auto.components.sidebar.DeleteWorktreeDialogFooter.c0e972d726', 'Cancel')}
      </Button>
      {!isMainWorktree && canForceDelete ? (
        <WorktreeForceDeleteButton
          buttonRef={confirmButtonRef}
          size="default"
          disabled={isDeleting}
          onForceDelete={onForceDelete}
          onSavingChange={onSavingChange}
          onAlwaysForceDelete={() =>
            useAppStore.getState().updateSettingsOrThrow({ alwaysForceDeleteWorktrees: true })
          }
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </WorktreeForceDeleteButton>
      ) : !isMainWorktree ? (
        <Button
          ref={confirmButtonRef}
          variant="destructive"
          onClick={onDelete}
          disabled={isDeleting}
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </Button>
      ) : null}
    </>
  )
}
