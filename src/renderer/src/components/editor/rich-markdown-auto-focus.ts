import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

/**
 * Auto-focuses the rich markdown editor on mount so users can start typing
 * immediately (matching MonacoEditor's behavior). Guards against focus theft
 * from modals/dialogs and skips scrollIntoView to avoid racing with
 * useEditorScrollRestore.
 *
 * `force` marks an explicit user handoff (Explorer open): it bypasses the theft
 * guard and claims DOM focus in this tick, because `commands.focus()` defers the
 * real `view.focus()` by a further frame. `shouldFocus` lets the caller retire a
 * handoff that expired while the frame was pending.
 */
export function autoFocusRichEditor(
  nextEditor: Editor,
  rootEl: HTMLElement | null,
  force = false,
  shouldFocus: () => boolean = () => true
): () => void {
  // Why: Tiptap can recreate the instance before its deferred focus lands, losing explicit handoffs.
  if (force && !nextEditor.isDestroyed && shouldFocus()) {
    nextEditor.view?.dom?.focus?.({ preventScroll: true })
  }
  let frameId: number | null = requestAnimationFrame(() => {
    frameId = null
    if (nextEditor.isDestroyed || !shouldFocus()) {
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
    // Why: a freshly-created empty document has an AllSelection, so focus it at
    // the start to render a normal caret. Ordinary remounts may already have a
    // restored TextSelection, which null preserves instead of resetting it.
    // Explicit handoffs still start at position 1.
    const focusPosition =
      force || !(nextEditor.state.selection instanceof TextSelection) ? 'start' : null
    //
    // Why: `scrollIntoView: false` prevents Tiptap's focus command from
    // scrolling the cursor into view, which would otherwise race with
    // useEditorScrollRestore's RAF retry loop and clobber the cached
    // scroll position on every tab switch.
    nextEditor.commands.focus(focusPosition, { scrollIntoView: false })
  })
  return () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }
  }
}
