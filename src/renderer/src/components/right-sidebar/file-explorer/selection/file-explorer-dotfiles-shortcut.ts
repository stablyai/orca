import type React from 'react'
import { useAppStore } from '@/store/index'
import { getKeybindingContext } from '@/lib/app-commands/app-command-handlers'
import { textFieldClaimsActionKey } from '@/lib/keyboard/text-field-shortcut-policy'
import { showTerminalShortcutCaptureNotification } from '@/lib/notifications/terminal-shortcut-capture-notification'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings/types'

/**
 * Handles the visible-explorer dotfiles toggle shortcut from anywhere in the workspace
 * (including chatbox and terminal) while yielding to text inputs, editors, and overlays.
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

  // Match the chord before DOM/overlay queries so ordinary typing does zero layout work.
  const context = getKeybindingContext(event.target)
  const terminalShortcutPolicy = useAppStore.getState().settings?.terminalShortcutPolicy
  if (
    !keybindingMatchesAction('fileExplorer.toggleDotfiles', event, platform, keybindings, {
      context,
      terminalShortcutPolicy
    })
  ) {
    return false
  }
  if (
    event.target instanceof Element &&
    (event.target.closest('[data-shortcut-recorder-active]') !== null ||
      event.target.closest('[data-ignore-file-explorer-keys="true"]') !== null)
  ) {
    return false
  }
  if (hasVisibleOverlay({ ignoreDismissed: true })) {
    return false
  }
  if (textFieldClaimsActionKey(event, 'fileExplorer.toggleDotfiles')) {
    return false
  }

  event.preventDefault()
  event.stopImmediatePropagation()
  if (!event.repeat && activeWorktreeId) {
    const previouslyFocused = document.activeElement
    const wasInExplorer =
      previouslyFocused instanceof Node &&
      Boolean(containerRef.current?.contains(previouslyFocused))
    useAppStore.getState().toggleShowDotfilesForWorktree(activeWorktreeId)
    if (context === 'terminal' && (terminalShortcutPolicy ?? 'orca-first') === 'orca-first') {
      showTerminalShortcutCaptureNotification({
        actionId: 'fileExplorer.toggleDotfiles',
        platform,
        keybindings
      })
    }
    // Why: hiding dotfiles unmounts a focused dotfile row; keep focus in the explorer so explorer keys continue working.
    if (wasInExplorer && previouslyFocused instanceof HTMLElement) {
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
