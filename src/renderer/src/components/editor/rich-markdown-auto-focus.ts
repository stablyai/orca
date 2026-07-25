import type { Editor } from '@tiptap/react'

/**
 * Auto-focuses the rich markdown editor on mount so users can start typing
 * immediately (matching MonacoEditor's behavior). Guards against focus theft
 * from modals/dialogs and skips scrollIntoView to avoid racing with
 * useEditorScrollRestore.
 */
export function autoFocusRichEditor(
  nextEditor: Editor,
  rootEl: HTMLElement | null,
  force = false
): () => void {
  let frameId: number | null = requestAnimationFrame(() => {
    frameId = null
    if (nextEditor.isDestroyed) {
      return
    }
    const active = document.activeElement
    // Why: explicit file-open requests may hand focus to the editor; ordinary
    // lazy mounts must still leave unrelated fields and dialogs alone.
    const canTakeFocus =
      force || active === null || active === document.body || (rootEl?.contains(active) ?? false)
    if (!canTakeFocus) {
      return
    }
    // Why: pass 'start' (not null) to resolve to a proper TextSelection at
    // doc position 1. With null, Tiptap keeps whatever the editor's current
    // selection happens to be on mount — for a freshly-created empty doc
    // that's an AllSelection, which renders as a visible 0-width highlight
    // inside the placeholder instead of a normal blinking caret.
    //
    // Why: `scrollIntoView: false` prevents Tiptap's focus command from
    // scrolling the cursor into view, which would otherwise race with
    // useEditorScrollRestore's RAF retry loop and clobber the cached
    // scroll position on every tab switch.
    nextEditor.commands.focus('start', { scrollIntoView: false })
  })
  return () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }
  }
}
