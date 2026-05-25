import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { keybindingMatchesAction, type KeybindingActionId } from '../../../../shared/keybindings'

export function editorShortcutMatches(
  actionId: KeybindingActionId,
  event: KeyboardEvent | ReactKeyboardEvent
): boolean {
  return keybindingMatchesAction(
    actionId,
    event,
    getShortcutPlatform(),
    useAppStore.getState().keybindings
  )
}

export function installEditorSaveShortcut(target: HTMLElement, onSave: () => void): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || !editorShortcutMatches('editor.save', event)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onSave()
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}
