import type React from 'react'
import { useAppStore } from '@/store/index'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings/types'

/**
 * Handles the dotfiles toggle shortcut while focus is inside the File Explorer,
 * restoring focus to the explorer viewport if hiding dotfiles unmounts the active row.
 */
export function tryHandleFileExplorerDotfilesShortcut(args: {
  event: KeyboardEvent
  platform: NodeJS.Platform
  keybindings: KeybindingOverrides
  activeWorktreeId: string | null
  containerRef: React.RefObject<HTMLDivElement | null>
}): boolean {
  const { event, platform, keybindings, activeWorktreeId, containerRef } = args
  if (event.defaultPrevented || event.isComposing || event.key === 'Process') {
    return false
  }
  if (!keybindingMatchesAction('fileExplorer.toggleDotfiles', event, platform, keybindings)) {
    return false
  }
  if (
    event.target instanceof Element &&
    event.target.closest('[data-shortcut-recorder-active]') !== null
  ) {
    return false
  }
  if (hasVisibleOverlay({ ignoreDismissed: true })) {
    return false
  }

  event.preventDefault()
  event.stopImmediatePropagation()
  if (!event.repeat && activeWorktreeId) {
    const previouslyFocused = document.activeElement
    useAppStore.getState().toggleShowDotfilesForWorktree(activeWorktreeId)
    // Why: hiding dotfiles unmounts a focused dotfile row; keep focus in the explorer so explorer keys continue working.
    if (previouslyFocused instanceof HTMLElement) {
      requestAnimationFrame(() => {
        if (
          !previouslyFocused.isConnected &&
          (document.activeElement === null || document.activeElement === document.body)
        ) {
          containerRef.current
            ?.querySelector<HTMLElement>('[tabindex="-1"]')
            ?.focus({ preventScroll: true })
        }
      })
    }
  }
  return true
}
