import React, { useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { runWorktreeMergeReviewReject } from './merge-review-flow'

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * Undoing a review normally just aborts the merge. When files were edited in the
 * main checkout while reviewing, undoing would discard those too, so the host
 * refuses and hands back the paths — this dialog is the only place that turns
 * that refusal into a destructive action.
 */
const MergeReviewRejectConfirmDialog = React.memo(function MergeReviewRejectConfirmDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const isOpen = activeModal === 'merge-review-reject'
  const worktreePath = readString(modalData.worktreePath)
  const paths = Array.isArray(modalData.paths)
    ? modalData.paths.filter((path): path is string => typeof path === 'string')
    : []

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleConfirm = useCallback(() => {
    if (!worktreePath) {
      closeModal()
      return
    }
    runWorktreeMergeReviewReject(
      {
        worktreePath,
        worktreeId: readString(modalData.worktreeId) ?? worktreePath,
        repoId: readString(modalData.repoId) ?? '',
        mainWorktreeId: readString(modalData.mainWorktreeId)
      },
      true
    )
    closeModal()
  }, [closeModal, modalData.mainWorktreeId, modalData.repoId, modalData.worktreeId, worktreePath])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'components.sidebar.mergeReview.rejectConfirmTitle',
              'Undo this merge and discard changes?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.sidebar.mergeReview.rejectConfirmBody',
              'These files were changed in the main worktree while the merge was awaiting review. Undoing the merge discards those changes too:'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek max-h-[40vh] min-w-0 overflow-y-auto">
          <ul className="min-w-0 space-y-1 font-mono text-xs">
            {paths.map((path) => (
              <li key={path} className="flex min-w-0 items-baseline gap-2">
                <AlertTriangle className="size-3 shrink-0 self-center text-destructive" />
                <span className="min-w-0 break-all">{path}</span>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('components.sidebar.mergeReview.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {translate('components.sidebar.mergeReview.reject', 'Undo Merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default MergeReviewRejectConfirmDialog
