import { toast } from 'sonner'
import { useAppStore } from '@/store'

export type ToastId = string | number

export type WorktreeScopedToast = {
  /** Re-issues the toast while it is on screen, e.g. so sonner re-measures a resized body. */
  refresh: () => void
  isShown: () => boolean
  /** Removes the toast for good and stops following workspace switches. */
  close: () => void
}

/**
 * Shows a long-running toast only while `worktreeId` is the active workspace.
 * Switching away dismisses it; switching back issues it again, so its body
 * re-reads whatever progress it tracks.
 */
export function openWorktreeScopedToast(args: {
  worktreeId: string
  /** Issues the toast; `id` is set only when updating one already on screen. */
  show: (id: ToastId | undefined) => ToastId
  /** Runs after the user switched away and the toast was dismissed. */
  onHidden?: () => void
}): WorktreeScopedToast {
  let id: ToastId | undefined
  let closed = false
  let active = useAppStore.getState().activeWorktreeId === args.worktreeId
  const show = (): void => {
    id = args.show(id)
  }
  const dismiss = (): void => {
    if (id !== undefined) {
      toast.dismiss(id)
      id = undefined
    }
  }
  if (active) {
    show()
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    const nextActive = state.activeWorktreeId === args.worktreeId
    if (closed || nextActive === active) {
      return
    }
    active = nextActive
    if (nextActive) {
      // Why: a fresh id, not the dismissed one — sonner may still be animating
      // that one out, and reusing it would update the leaving toast instead.
      show()
      return
    }
    dismiss()
    args.onHidden?.()
  })
  return {
    refresh: () => {
      if (!closed && active) {
        show()
      }
    },
    isShown: () => !closed && active,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      unsubscribe()
      dismiss()
    }
  }
}
