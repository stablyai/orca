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
  event.preventDefault()
  // No-ops without a selection or with annotations disabled — the controller
  // guards on a live annotation target.
  ctx.openAnnotationPopoverRef.current()
  return true
}
