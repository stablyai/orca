import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { isEventTargetInsideFloatingWorkspacePanel } from '@/lib/floating-workspace-terminal-actions'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'

/**
 * Find is this PDF's when the key comes from inside it, or when it owns the panel's commands (the
 * active tab of the focused group, as the browser pane decides) and the key is not typed into a
 * text field. Its own tab, header and the file explorer keep the group focused; a chat, terminal
 * or browser in another split focuses its own group.
 */
export function pdfViewerOwnsFind(
  root: HTMLElement | null,
  target: EventTarget | null,
  ownsCommands: boolean
): boolean {
  if (!root || !(target instanceof Node)) {
    return false
  }
  if (root.contains(target)) {
    return true
  }
  // The floating panel has its own focused group: each window surface answers only its own keys.
  return (
    ownsCommands &&
    !isEditableTarget(target instanceof Element ? target : null) &&
    isEventTargetInsideFloatingWorkspacePanel(target) ===
      isEventTargetInsideFloatingWorkspacePanel(root)
  )
}

export function usePdfViewerFindShortcut({
  rootRef,
  ownsCommands,
  keybindings,
  openFind
}: {
  rootRef: RefObject<HTMLElement | null>
  ownsCommands: boolean
  keybindings: KeybindingOverrides | undefined
  openFind: () => void
}): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('editor.find', e, getShortcutPlatform(), keybindings)) {
        return
      }
      // Why: a PDF stays mounted in a hidden worktree or another split; it must not take
      // Mod+F from the surface the user is in (a chat, a preview).
      if (!pdfViewerOwnsFind(rootRef.current, e.target, ownsCommands)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      openFind()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [keybindings, openFind, ownsCommands, rootRef])
}
