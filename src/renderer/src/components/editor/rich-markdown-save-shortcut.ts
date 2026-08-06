import type { KeyHandlerContext } from './rich-markdown-key-handler'
import { editorShortcutMatches } from './editor-shortcuts'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

/**
 * Cmd/Ctrl+S: flush the debounced serialization, then reconcile toward the
 * original source style before saving so untouched regions keep their bytes.
 */
export function handleRichMarkdownSaveShortcut(
  ctx: KeyHandlerContext,
  event: KeyboardEvent
): boolean {
  if (!editorShortcutMatches('editor.save', event)) {
    return false
  }
  event.preventDefault()
  // Why: flush pending debounced serialization so the save captures the very
  // latest editor content, not a stale snapshot.
  ctx.flushPendingSerialization()
  // Why: the flush already reconciled + updated refs, so this re-serialize is
  // idempotent (edited === baseCanonical → returns the reconciled bytes). On a
  // torn-down editor it falls back to the last committed bytes without patching.
  const { markdown } = commitRichMarkdownSerialization(
    ctx.editorRef.current,
    ctx,
    ctx.reconcileRoundTripRef.current
  )
  ctx.onContentChangeRef.current(markdown)
  ctx.onSaveRef.current(markdown)
  return true
}
