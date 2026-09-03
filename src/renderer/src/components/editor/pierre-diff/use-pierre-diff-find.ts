import { useCallback, useRef, useState } from 'react'
import type { EditorFocusOptions } from '@pierre/diffs/edit'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { editorShortcutMatches } from '../editor-shortcuts'
import { getDeepActiveElement } from './pierre-diff-active-element'

// Why: Pierre only ships its search panel with edit mode, and it has no
// programmatic command dispatch — replay the shortcut its own listener expects.
function dispatchPierreOpenSearchPanel(): void {
  const target = getDeepActiveElement()
  if (!target) {
    return
  }
  const isMac = getShortcutPlatform() === 'darwin'
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'f',
      code: 'KeyF',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      composed: true,
      cancelable: true
    })
  )
}

// Why: only `focus` is needed here, so stay structural and annotation-agnostic.
type FocusableEditor = { focus: (options?: EditorFocusOptions) => void }

export type PierreDiffFind = {
  /** True when the surface should mount an edit session (real editing or find). */
  editEnabled: boolean
  /** Capture-phase keydown handler for the surface container. */
  handleContainerKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  /** Pass to `editorOptions.onAttach` so the panel opens on the first press. */
  handleEditorAttach: (editor: FocusableEditor) => void
  /** Leaves a find-only session so a read-only diff stops accepting input. */
  exitFind: () => void
}

/**
 * Bridges our ⌘F keybinding onto Pierre's edit-mode search panel. On a
 * read-only diff the session exists only for find, and nothing is ever written
 * back, so dismissing it discards any stray keystrokes.
 */
export function usePierreDiffFind({ isEditable }: { isEditable: boolean }): PierreDiffFind {
  const [findActive, setFindActive] = useState(false)
  const pendingFindRef = useRef(false)

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (findActive || !editorShortcutMatches('editor.find', event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pendingFindRef.current = true
      setFindActive(true)
    },
    [findActive]
  )

  const handleEditorAttach = useCallback((editor: FocusableEditor) => {
    if (!pendingFindRef.current) {
      return
    }
    pendingFindRef.current = false
    editor.focus({ lineNumber: 'first-visible', preventScroll: true })
    dispatchPierreOpenSearchPanel()
  }, [])

  const exitFind = useCallback(() => {
    pendingFindRef.current = false
    setFindActive(false)
  }, [])

  return {
    editEnabled: isEditable || findActive,
    handleContainerKeyDown,
    handleEditorAttach,
    exitFind
  }
}
