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

export function installEditorFindShortcut(target: HTMLElement, onFind: () => void): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.find', event)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    // Why: matched repeats must stay consumed so Monaco cannot reopen or reset find.
    if (!event.repeat) {
      onFind()
    }
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}

type MonacoDiffNavigationEditor = {
  getContainerDomNode: () => HTMLElement
  goToDiff: (target: 'next' | 'previous') => void
}

export function installMonacoDiffChangeNavigationShortcut(
  editor: MonacoDiffNavigationEditor
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    let direction: 'next' | 'previous' | null = null
    if (editorShortcutMatches('editor.nextChange', event)) {
      direction = 'next'
    } else if (editorShortcutMatches('editor.previousChange', event)) {
      direction = 'previous'
    }
    if (!direction) {
      return
    }
    // Capture before Monaco opens its built-in F7 accessible-review pane.
    event.preventDefault()
    event.stopPropagation()
    // Consume matched repeats but navigate once per press (matches find shortcut).
    if (!event.repeat) {
      editor.goToDiff(direction)
    }
  }

  const target = editor.getContainerDomNode()
  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}

export function installEditorAddReviewNoteShortcut(
  target: HTMLElement,
  onAddReviewNote: () => boolean
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.addReviewNote', event)) {
      return
    }
    // Ignore held chords; mounted drafts consume repeats through installOpenDraftAddReviewNoteGuard.
    if (event.repeat) {
      return
    }
    // Leave the chord available to other bindings when this surface cannot open a composer.
    if (onAddReviewNote()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}

/** Consume the chord and repeats within the composer subtree to prevent remounts without swallowing another pane’s shortcuts. */
export function installOpenDraftAddReviewNoteGuard(target: HTMLElement): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.addReviewNote', event)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}

type MonacoFindShortcutEditor = {
  getAction: (id: string) => { run: () => void | Promise<void> } | null
  getContainerDomNode: () => HTMLElement
}

export function installMonacoEditorFindShortcut(editor: MonacoFindShortcutEditor): () => void {
  return installEditorFindShortcut(editor.getContainerDomNode(), () => {
    void editor.getAction('actions.find')?.run()
  })
}
