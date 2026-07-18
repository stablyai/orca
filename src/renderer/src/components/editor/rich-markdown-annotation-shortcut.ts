import type { KeyHandlerContext } from './rich-markdown-key-handler'
import { editorShortcutMatches } from './editor-shortcuts'

/**
 * Mod+Shift+A: open the review-note composer for the current selection.
 */
export function handleRichMarkdownAddReviewNoteShortcut(
  ctx: KeyHandlerContext,
  event: KeyboardEvent
): boolean {
  if (!editorShortcutMatches('editor.addReviewNote', event)) {
    return false
  }
  // Why: require the live selection so a collapsed selection cannot reopen a
  // stale target; consume the chord only when a composer actually opens.
  if (!ctx.openAnnotationPopoverRef.current(true)) {
    return false
  }
  event.preventDefault()
  return true
}
