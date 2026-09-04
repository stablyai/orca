import { useCallback } from 'react'
import {
  getWorktreeParentPickerAnchor,
  PARENT_PICKER_EXIT_ANIMATION_MS
} from './worktree-context-menu-policy'

type PendingParentPicker = { childWorktreeId: string; anchorElement: HTMLElement }

export function useWorktreeParentPickerTransition(args: {
  fallbackTimerRef: React.MutableRefObject<number | null>
  pendingRef: React.MutableRefObject<PendingParentPicker | null>
  scopeRef: React.RefObject<HTMLDivElement | null>
  setMenuOpenState: (open: boolean) => void
  setParentPicker: (picker: PendingParentPicker | null) => void
  setParentPickerOpen: (open: boolean) => void
  unmountTimerRef: React.MutableRefObject<number | null>
  worktreeId: string
}) {
  const openPendingParentPicker = useCallback(() => {
    const pending = args.pendingRef.current
    if (!pending) {
      return
    }
    args.pendingRef.current = null
    if (args.fallbackTimerRef.current != null) {
      window.clearTimeout(args.fallbackTimerRef.current)
      args.fallbackTimerRef.current = null
    }
    if (args.unmountTimerRef.current != null) {
      window.clearTimeout(args.unmountTimerRef.current)
      args.unmountTimerRef.current = null
    }
    args.setParentPicker(pending)
    args.setParentPickerOpen(true)
  }, [args])
  const handleParentPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      args.setParentPickerOpen(false)
      args.unmountTimerRef.current = window.setTimeout(() => {
        args.unmountTimerRef.current = null
        args.setParentPicker(null)
      }, PARENT_PICKER_EXIT_ANIMATION_MS)
    },
    [args]
  )
  const handleOpenParentPicker = useCallback(
    (event?: { preventDefault: () => void }) => {
      event?.preventDefault()
      const anchorElement = getWorktreeParentPickerAnchor(args.scopeRef.current, args.worktreeId)
      if (!anchorElement) {
        return
      }
      args.pendingRef.current = { childWorktreeId: args.worktreeId, anchorElement }
      args.setMenuOpenState(false)
      args.fallbackTimerRef.current = window.setTimeout(openPendingParentPicker, 50)
    },
    [args, openPendingParentPicker]
  )
  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      // Why: Radix otherwise restores focus to the hidden context-menu trigger.
      // When Sleep/Delete clears the active workspace and remounts the sidebar,
      // that focus restore can scroll the virtual list away from the row the
      // user just acted on.
      event.preventDefault()
      if (args.pendingRef.current) {
        window.setTimeout(openPendingParentPicker, 0)
        return
      }
      const sidebar = args.scopeRef.current?.closest('[data-worktree-sidebar]')
      if (sidebar instanceof HTMLElement) {
        sidebar.focus({ preventScroll: true })
      }
    },
    [args, openPendingParentPicker]
  )
  return {
    handleCloseAutoFocus,
    handleOpenParentPicker,
    handleParentPickerOpenChange,
    openPendingParentPicker
  }
}
