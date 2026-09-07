import { useCallback, useEffect } from 'react'
import {
  clearFloatingPanelReclaimIntent,
  consumeFloatingPanelReclaimIntent
} from '@/lib/floating-workspace-focus-reclaim'
import { reportFloatingFocus } from './floating-terminal-focus-reporting'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

type FloatingTerminalPanelFocusReclaimInput = Pick<
  FloatingTerminalPanelLocalState,
  'panelRef' | 'shortcutFocusFrameRef' | 'shortcutFocusTimeoutRef' | 'pendingReclaimArmByFileIdRef'
> &
  Pick<FloatingTerminalPanelItems, 'visibleFloatingItemCount'> &
  Pick<FloatingTerminalPanelStoreState, 'floatingFiles'>

export function useFloatingTerminalPanelFocusReclaim({
  panelRef,
  shortcutFocusFrameRef,
  shortcutFocusTimeoutRef,
  pendingReclaimArmByFileIdRef,
  visibleFloatingItemCount,
  floatingFiles
}: FloatingTerminalPanelFocusReclaimInput) {
  const focusPanelForShortcuts = useCallback(
    (preserveExistingPanelFocus = true) => {
      const active = document.activeElement
      if (
        preserveExistingPanelFocus &&
        active instanceof HTMLElement &&
        active.closest('[data-floating-terminal-panel]') !== null
      ) {
        return
      }
      panelRef.current?.focus({ preventScroll: true })
    },
    [panelRef]
  )

  const cancelShortcutFocusFrame = useCallback((): void => {
    if (shortcutFocusFrameRef.current !== null) {
      cancelAnimationFrame(shortcutFocusFrameRef.current)
      shortcutFocusFrameRef.current = null
    }
    if (shortcutFocusTimeoutRef.current !== null) {
      window.clearTimeout(shortcutFocusTimeoutRef.current)
      shortcutFocusTimeoutRef.current = null
    }
  }, [shortcutFocusFrameRef, shortcutFocusTimeoutRef])

  const setPanelNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) {
        cancelShortcutFocusFrame()
      }
      panelRef.current = node
    },
    [cancelShortcutFocusFrame, panelRef]
  )

  const focusPanelForShortcutsAfterClose = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    cancelShortcutFocusFrame()
    const focusPanel = (): void => {
      shortcutFocusFrameRef.current = null
      shortcutFocusTimeoutRef.current = null
      focusPanelForShortcuts(false)
    }
    if (typeof window.requestAnimationFrame === 'function') {
      shortcutFocusFrameRef.current = window.requestAnimationFrame(focusPanel)
      return
    }
    shortcutFocusTimeoutRef.current = window.setTimeout(focusPanel, 0)
  }, [
    cancelShortcutFocusFrame,
    focusPanelForShortcuts,
    shortcutFocusFrameRef,
    shortcutFocusTimeoutRef
  ])

  const reportFloatingFocusFromTarget = useCallback((target: EventTarget | null): void => {
    reportFloatingFocus(target)
  }, [])

  useEffect(() => {
    const pending = pendingReclaimArmByFileIdRef.current
    if (pending.size === 0) {
      return
    }
    for (const [fileId, armIfEmptying] of pending) {
      if (!floatingFiles.some((file) => file.id === fileId)) {
        pending.delete(fileId)
        armIfEmptying()
      }
    }
  }, [floatingFiles, pendingReclaimArmByFileIdRef])

  useEffect(() => {
    if (visibleFloatingItemCount > 0) {
      clearFloatingPanelReclaimIntent()
      return
    }
    if (consumeFloatingPanelReclaimIntent()) {
      focusPanelForShortcutsAfterClose()
    }
  }, [focusPanelForShortcutsAfterClose, visibleFloatingItemCount])

  return { focusPanelForShortcuts, setPanelNode, reportFloatingFocusFromTarget }
}

export type FloatingTerminalPanelFocusReclaim = ReturnType<
  typeof useFloatingTerminalPanelFocusReclaim
>
