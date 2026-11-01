import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { isEventTargetInsideFloatingWorkspacePanel } from '@/lib/floating-workspace-terminal-actions'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

/** Claim Find inside this PDF or through its focused group, excluding other text fields and split/window surfaces. */
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
      // Hidden workspaces and other splits retain PDFs; only the current surface may claim Find.
      if (!pdfViewerOwnsFind(rootRef.current, e.target, ownsCommands)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      openFind()
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [keybindings, openFind, ownsCommands, rootRef])
}
