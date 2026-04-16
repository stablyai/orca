import React, { useCallback, useEffect, useMemo, useRef } from 'react'
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
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

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
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const worktreeName = worktree?.displayName ?? 'unknown'
  // Why: the main worktree is the repo's original clone directory — `git worktree remove`
  // always rejects it. We block the delete button upfront so the user doesn't have to
  // discover this limitation via a confusing force-delete dead-end.
  const isMainWorktree = worktree?.isMainWorktree ?? false

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
            const toastCopy = getDeleteWorktreeToastCopy(
              worktreeName,
              state?.canForceDelete ?? false,
              result.error
            )
            const showToast = toastCopy.isDestructive ? toast.error : toast.info
            showToast(toastCopy.title, {
              description: toastCopy.description,
              duration: 10000,
              cancel: {
                label: 'View',
                onClick: () => activateAndRevealWorktree(targetWorktreeId)
              },
              action: state?.canForceDelete
                ? {
                    label: 'Force Delete',
                    onClick: () => {
                      removeWorktree(targetWorktreeId, true)
                        .then((forceResult) => {
                          if (!forceResult.ok) {
                            toast.error('Force delete failed', {
                              description: forceResult.error,
                              action: {
                                label: 'View',
                                onClick: () => activateAndRevealWorktree(targetWorktreeId)
                              }
                            })
                          }
                        })
                        .catch((err: unknown) => {
                          toast.error('Failed to delete worktree', {
                            description: err instanceof Error ? err.message : String(err),
                            action: {
                              label: 'View',
                              onClick: () => activateAndRevealWorktree(targetWorktreeId)
                            }
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
    [closeModal, removeWorktree, worktreeId, worktreeName]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          if (isMainWorktree) {
            return
          }
          event.preventDefault()
          // Why: this confirmation dialog exists specifically to guard a
          // destructive action the user already chose from the context menu.
          // Radix otherwise picks the first tabbable control, which can be the
          // cancel/close affordance and breaks the expected "Delete, Enter"
          // flow for quick keyboard confirmation.
          confirmButtonRef.current?.focus()
        }}
      >
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

        {isMainWorktree && (
          <div className="rounded-md border border-blue-500/40 bg-blue-500/8 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                This is the <span className="font-semibold">main worktree</span> (the original clone
                directory). Git does not allow removing the main worktree.
              </div>
            </div>
          </div>
        )}

        {deleteError && !isMainWorktree && (
          <div className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-all">{deleteError}</div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isDeleting}>
            {isMainWorktree ? 'Close' : 'Cancel'}
          </Button>
          {!isMainWorktree &&
            (canForceDelete ? (
              <Button
                ref={confirmButtonRef}
                variant="destructive"
                onClick={() => handleDelete(true)}
                disabled={isDeleting}
              >
                {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
                {isDeleting ? 'Force Deleting…' : 'Force Delete'}
              </Button>
            ) : (
              <Button
                ref={confirmButtonRef}
                variant="destructive"
                onClick={() => handleDelete(false)}
                disabled={isDeleting}
              >
                {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
                {isDeleting ? 'Deleting…' : 'Delete'}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
