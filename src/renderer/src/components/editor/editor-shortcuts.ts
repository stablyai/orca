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
    // Why: capture-phase preventDefault/stopPropagation beats Monaco's built-in
    // F7 accessible-review pane, like the find shortcut does for Cmd+F.
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
    // Why: ignore OS key-repeat so a held chord cannot thrash open/remount.
    // Open drafts are consumed by installOpenDraftAddReviewNoteGuard instead.
    if (event.repeat) {
      return
    }
    // Why: only consume the chord when a composer actually opens; on files
    // where review notes can never apply the key must stay available to
    // whatever else the user bound it to.
    if (onAddReviewNote()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}

/**
 * While a review-note/diff-comment draft composer is mounted, consume the
 * bindable add-review-note chord (including OS key-repeat) so a second press
 * cannot remount the composer or leak into other handlers (product B).
 *
 * Scoped to the composer's own subtree (which contains the focused textarea)
 * rather than `window` so a draft open in one editor pane never swallows the
 * chord typed into a different pane or surface.
 */
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
