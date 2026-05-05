import type { Editor } from '@tiptap/react'

/**
 * Auto-focuses the rich markdown editor on mount so users can start typing
 * immediately (matching MonacoEditor's behavior). Guards against focus theft
 * from modals/dialogs and skips scrollIntoView to avoid racing with
 * useEditorScrollRestore.
 */
export function autoFocusRichEditor(nextEditor: Editor, rootEl: HTMLElement | null): void {
  requestAnimationFrame(() => {
    if (nextEditor.isDestroyed) {
      return
    }
    // Why: don't steal focus if something outside the editor root is already
    // focused (modal, rename dialog, sidebar search input, etc.). Only
    // auto-focus when focus is nowhere or already inside the editor.
    const active = document.activeElement
    const isNeutralFocus =
      active === null || active === document.body || (rootEl?.contains(active) ?? false)
    if (!isNeutralFocus) {
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
}
