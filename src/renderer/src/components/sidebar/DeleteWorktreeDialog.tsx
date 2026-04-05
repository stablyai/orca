import React, { useCallback, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, LoaderCircle, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAppStore((s) => s.allWorktrees)

  const isOpen = activeModal === 'delete-worktree'
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const worktree = useMemo(
    () => (worktreeId ? (allWorktrees().find((item) => item.id === worktreeId) ?? null) : null),
    [allWorktrees, worktreeId]
  )
  const deleteState = useAppStore((s) =>
    worktreeId ? s.deleteStateByWorktreeId[worktreeId] : undefined
  )
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteError = deleteState?.error ?? null
  const canForceDelete = deleteState?.canForceDelete ?? false

  useEffect(() => {
    if (isOpen && worktreeId && !worktree && !isDeleting) {
      clearWorktreeDeleteState(worktreeId)
      closeModal()
    }
  }, [clearWorktreeDeleteState, closeModal, isDeleting, isOpen, worktree, worktreeId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      const currentState = worktreeId
        ? useAppStore.getState().deleteStateByWorktreeId[worktreeId]
        : undefined
      if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId)
      }
      closeModal()
    },
    [clearWorktreeDeleteState, closeModal, worktreeId]
  )

  const handleDelete = useCallback(
    (force = false) => {
      if (!worktreeId) {
        return
      }
      const targetWorktreeId = worktreeId
      removeWorktree(targetWorktreeId, force)
        .then((result) => {
          if (!result.ok) {
            const state = useAppStore.getState().deleteStateByWorktreeId[targetWorktreeId]
            toast.error('Failed to delete worktree', {
              description: result.error,
              duration: 10000,
              action: state?.canForceDelete
                ? {
                    label: 'Force Delete',
                    onClick: () => {
                      removeWorktree(targetWorktreeId, true)
                        .then((forceResult) => {
                          if (!forceResult.ok) {
                            toast.error('Force delete failed', { description: forceResult.error })
                          }
                        })
                        .catch((err: unknown) => {
                          toast.error('Failed to delete worktree', {
                            description: err instanceof Error ? err.message : String(err)
                          })
                        })
                    }
                  }
                : undefined
            })
          }
        })
        .catch((err: unknown) => {
          toast.error('Failed to delete worktree', {
            description: err instanceof Error ? err.message : String(err)
          })
        })
      closeModal()
    },
    [closeModal, removeWorktree, worktreeId]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Delete Worktree</DialogTitle>
          <DialogDescription className="text-xs">
            Remove{' '}
            <span className="break-all font-medium text-foreground">{worktree?.displayName}</span>{' '}
            from git and delete its working tree folder.
          </DialogDescription>
        </DialogHeader>

        {worktree && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{worktree.displayName}</div>
            <div className="mt-1 break-all text-muted-foreground">{worktree.path}</div>
          </div>
        )}

        {deleteError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-all">{deleteError}</div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          {canForceDelete ? (
            <Button variant="destructive" onClick={() => handleDelete(true)} disabled={isDeleting}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
              {isDeleting ? 'Force Deleting…' : 'Force Delete'}
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => handleDelete(false)} disabled={isDeleting}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
