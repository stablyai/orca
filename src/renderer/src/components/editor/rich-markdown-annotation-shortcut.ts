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
  // Why: ignore OS key-repeat so a held chord cannot thrash open/remount.
  // Open drafts are consumed by installOpenDraftAddReviewNoteGuard on the
  // mounted composer (product B), including when focus is in the textarea.
  if (event.repeat) {
    return false
  }
  // Why: require the live selection so a collapsed selection cannot reopen a
  // stale target; consume only when a composer opens or an open draft is kept
  // (openAnnotationPopover returns true for both). openAnnotationPopover flushes
  // the pending ProseMirror selection before reading the target, so an immediate
  // chord after a mouse-drag sees the live selection rather than stale state.
  if (!ctx.openAnnotationPopoverRef.current(true)) {
    return false
  }
  event.preventDefault()
  return true
}
