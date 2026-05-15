import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Check, LoaderCircle, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { runWorktreeDeletesSequentially } from './delete-worktree-flow'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAppStore((s) => s.allWorktrees)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)

  const isOpen = activeModal === 'delete-worktree'
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const worktreeIds = useMemo(
    () =>
      Array.isArray(modalData.worktreeIds)
        ? modalData.worktreeIds.filter((id): id is string => typeof id === 'string')
        : worktreeId
          ? [worktreeId]
          : [],
    [modalData.worktreeIds, worktreeId]
  )
  const onDeleted =
    typeof modalData.onDeleted === 'function'
      ? (modalData.onDeleted as (worktreeIds: string[]) => void)
      : null
  const worktree = useMemo(
    () => (worktreeId ? (allWorktrees().find((item) => item.id === worktreeId) ?? null) : null),
    [allWorktrees, worktreeId]
  )
  const worktrees = useMemo(() => {
    if (worktreeIds.length === 0) {
      return []
    }
    const selected = new Set(worktreeIds)
    return allWorktrees().filter((item) => selected.has(item.id))
  }, [allWorktrees, worktreeIds])
  const deleteState = useAppStore((s) =>
    worktreeId ? s.deleteStateByWorktreeId[worktreeId] : undefined
  )
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteError = deleteState?.error ?? null
  const canForceDelete = deleteState?.canForceDelete ?? false
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const isBatchDelete = worktreeIds.length > 1
  const allowSkipConfirm = !isBatchDelete && modalData.allowSkipConfirm !== false
  // Why: the main worktree is the repo's original clone directory — `git worktree remove`
  // always rejects it. We block the delete button upfront so the user doesn't have to
  // discover this limitation via a confusing force-delete dead-end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // Why: the checkbox is a one-shot intent captured inside the dialog — when
  // the dialog closes (cancel, delete, or esc) we reset it so the next open
  // starts unchecked. Without this, toggling the box and cancelling would
  // silently re-surface the checked state on the next delete.
  useEffect(() => {
    if (!isOpen) {
      setDontAskAgain(false)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && worktreeIds.length > 0 && worktrees.length === 0 && !isDeleting) {
      clearWorktreeDeleteState(worktreeId)
      closeModal()
    }
  }, [
    clearWorktreeDeleteState,
    closeModal,
    isDeleting,
    isOpen,
    worktreeId,
    worktreeIds.length,
    worktrees.length
  ])

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

  const persistDontAskAgainPreference = useCallback((): void => {
    void updateSettings({ skipDeleteWorktreeConfirm: true })
    // Why: the toast confirms the preference was saved and points the user at
    // where to undo it. The "Open Settings" action deep-links to the General
    // pane so they never have to hunt for the toggle if they change their mind.
    toast.success("We'll skip this confirmation next time.", {
      description: 'You can change this in Settings.',
      duration: 8000,
      action: {
        label: 'Open Settings',
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-worktree-confirm'
          })
        }
      }
    })
  }, [openSettingsPage, openSettingsTarget, updateSettings])

  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeIds.length === 0) {
        return
      }
      // Why: force-delete is a recovery path taken after a failed first delete.
      // Saving "don't ask again" from that state would conflate the recovery
      // action with a broader preference. Only persist the preference on the
      // primary (non-force) confirmation so users intentionally opt in.
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
      if (force) {
        // Why: this branch preserves the legacy "Force Delete" button behavior
        // inside the dialog — it runs the destructive retry directly without
        // the shared toast wrapper, since the user is already looking at an
        // error state and a success silently closes the dialog.
        removeWorktree(worktreeId, true)
          .then((result) => {
            if (!result.ok) {
              toast.error('Force delete failed', {
                description: result.error
              })
              return
            }
            onDeleted?.([worktreeId])
          })
          .catch((err: unknown) => {
            toast.error('Failed to delete worktree', {
              description: err instanceof Error ? err.message : String(err)
            })
          })
      } else {
        void runWorktreeDeletesSequentially(worktrees).then((deletedIds) => {
          if (deletedIds.length > 0) {
            onDeleted?.(deletedIds)
          }
        })
      }
      closeModal()
    },
    [
      closeModal,
      dontAskAgain,
      allowSkipConfirm,
      onDeleted,
      persistDontAskAgainPreference,
      removeWorktree,
      worktreeIds.length,
      worktreeId,
      worktrees
    ]
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
          <DialogTitle className="text-sm">
            {isBatchDelete ? 'Delete Worktrees' : 'Delete Worktree'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isBatchDelete ? (
              <>
                Remove{' '}
                <span className="font-medium text-foreground">{worktrees.length} worktrees</span>{' '}
                from git and delete their working tree folders.
              </>
            ) : (
              <>
                Remove{' '}
                <span className="break-all font-medium text-foreground">
                  {worktree?.displayName}
                </span>{' '}
                from git and delete its working tree folder.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {isBatchDelete ? (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            {worktrees.map((item) => (
              <div key={item.id} className="min-w-0 border-b border-border/50 py-1 last:border-0">
                <div className="break-all font-medium text-foreground">{item.displayName}</div>
                <div className="mt-0.5 break-all text-muted-foreground">{item.path}</div>
              </div>
            ))}
          </div>
        ) : worktree ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{worktree.displayName}</div>
            <div className="mt-1 break-all text-muted-foreground">{worktree.path}</div>
          </div>
        ) : null}

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

        {!isMainWorktree && allowSkipConfirm && !canForceDelete && (
          // Why: only show "Don't ask again" for the primary confirmation. The
          // force-delete variant is a recovery path that shouldn't double as a
          // preference checkpoint; see handleDelete for the matching guard.
          <button
            type="button"
            role="checkbox"
            aria-checked={dontAskAgain}
            onClick={() => setDontAskAgain((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                dontAskAgain
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {dontAskAgain ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Don&apos;t ask again
          </button>
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
                {isDeleting ? 'Deleting…' : isBatchDelete ? `Delete ${worktrees.length}` : 'Delete'}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
