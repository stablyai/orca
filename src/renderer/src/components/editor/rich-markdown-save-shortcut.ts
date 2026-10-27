import type { KeyHandlerContext } from './rich-markdown-key-handler'
import { editorShortcutMatches } from './editor-shortcuts'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

/** Flush debounced text and preserve untouched source style before saving. */
export function handleRichMarkdownSaveShortcut(
  ctx: KeyHandlerContext,
  event: KeyboardEvent
): boolean {
  if (!editorShortcutMatches('editor.save', event)) {
    return false
  }
  event.preventDefault()
  if (ctx.flushPendingSerialization()) {
    // Why: the view's text was just rejected as stale; saving it would overwrite the newer text.
    return true
  }
  // The flush already advanced refs, making reserialization idempotent; torn-down editors reuse the last committed bytes.
  const { markdown } = commitRichMarkdownSerialization(
    ctx.editorRef.current,
    ctx,
    ctx.reconcileRoundTripRef.current
  )
  ctx.onContentChangeRef.current(markdown)
  ctx.onSaveRef.current(markdown)
  return true
}
