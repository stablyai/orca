import type { JSX, Ref } from 'react'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
        {isMainWorktree ? 'Close' : 'Cancel'}
      </Button>
      {!isMainWorktree && (
        <Button
          ref={confirmButtonRef}
          variant="destructive"
          onClick={canForceDelete ? onForceDelete : onDelete}
          disabled={isDeleting}
        >
          {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
          {label}
        </Button>
      )}
    </>
  )
}
