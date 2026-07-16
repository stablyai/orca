import type { KeyHandlerContext } from './rich-markdown-key-handler'
import { editorShortcutMatches } from './editor-shortcuts'

/**
 * Mod+Alt+N: open the review-note composer for the current selection.
 */
export function handleRichMarkdownAddReviewNoteShortcut(
  ctx: KeyHandlerContext,
  event: KeyboardEvent
): boolean {
  if (!editorShortcutMatches('editor.addReviewNote', event)) {
    return false
  }
  // Why: consume the chord only when the composer actually opens (same
  // contract as the Monaco and preview surfaces), so a rebound chord stays
  // available when annotations are off or nothing is selected.
  if (!ctx.openAnnotationPopoverRef.current()) {
    return false
  }
  event.preventDefault()
  return true
}
