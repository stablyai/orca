import { useCallback, useRef, useState } from 'react'
import type { EditorFocusOptions } from '@pierre/diffs/edit'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { editorShortcutMatches } from '../editor-shortcuts'

/**
 * Pierre only accepts key events whose target is its own content element, so
 * reach into the shadow root rather than trusting whatever holds focus — at
 * attach time focus has not landed there yet.
 */
function findPierreContentElement(container: HTMLElement | null): HTMLElement | null {
  const host = container?.querySelector('diffs-container')
  const editable = host?.shadowRoot?.querySelector('[contenteditable]')
  return editable instanceof HTMLElement ? editable : null
}

// Why: Pierre only ships its search panel with edit mode, and it has no
// programmatic command dispatch — replay the shortcut its own listener expects.
function dispatchPierreOpenSearchPanel(target: HTMLElement): void {
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
  /** Ends a find-only session when focus leaves the surface. */
  handleContainerBlur: (event: React.FocusEvent<HTMLElement>) => void
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
export function usePierreDiffFind({
  isEditable,
  containerRef
}: {
  isEditable: boolean
  containerRef: React.RefObject<HTMLElement | null>
}): PierreDiffFind {
  const [findActive, setFindActive] = useState(false)
  const pendingFindRef = useRef(false)

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      // Why: a find-only session must not outlive the search panel, or a
      // read-only diff stays editable forever after a single Cmd+F.
      if (findActive && event.key === 'Escape') {
        pendingFindRef.current = false
        setFindActive(false)
        return
      }
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

  // Why: leaving the surface ends a find-only session too; the panel is gone.
  const handleContainerBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (!findActive || event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return
      }
      pendingFindRef.current = false
      setFindActive(false)
    },
    [findActive]
  )

  const handleEditorAttach = useCallback(
    (editor: FocusableEditor) => {
      if (!pendingFindRef.current) {
        return
      }
      pendingFindRef.current = false
      editor.focus({ lineNumber: 'first-visible', preventScroll: true })
      // Why: the editable DOM is not focusable until after this commit paints,
      // so a same-tick dispatch misses Pierre's content element and the first
      // Cmd+F is swallowed — which is why it used to take two presses.
      requestAnimationFrame(() => {
        const target = findPierreContentElement(containerRef.current)
        if (target) {
          target.focus()
          dispatchPierreOpenSearchPanel(target)
        }
      })
    },
    [containerRef]
  )

  const exitFind = useCallback(() => {
    pendingFindRef.current = false
    setFindActive(false)
  }, [])

  return {
    editEnabled: isEditable || findActive,
    handleContainerKeyDown,
    handleContainerBlur,
    handleEditorAttach,
    exitFind
  }
}
