import type { KeyHandlerContext } from './rich-markdown-key-handler'
import { editorShortcutMatches } from './editor-shortcuts'

export function handleRichMarkdownAddReviewNoteShortcut(
  ctx: KeyHandlerContext,
  event: KeyboardEvent
): boolean {
  if (!editorShortcutMatches('editor.addReviewNote', event)) {
    return false
  }
  // Ignore held chords; mounted composers consume repeats through installOpenDraftAddReviewNoteGuard.
  if (event.repeat) {
    return false
  }
  // Read the live ProseMirror selection after flushing pending mouse selection; consume only if a composer opens or its draft survives.
  if (!ctx.openAnnotationPopoverRef.current(true)) {
    return false
  }
  event.preventDefault()
  return true
}
