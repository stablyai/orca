import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { serializeRichMarkdownSliceForClipboard } from './rich-markdown-clipboard-serialization'
import { inspectRichMarkdownSourceOwningSlice } from './rich-markdown-source-owning-slice'
import { showRichMarkdownSourceOwningCutLimitError } from './rich-markdown-source-owning-cut-feedback'

/** Verify rich clipboard readback; false forbids deleting the cut selection after a limit or write rejection. */
export function writeRichMarkdownSliceToClipboard(
  clipboardData: DataTransfer,
  view: EditorView,
  slice: Slice,
  visibleText: string
): boolean {
  const status = inspectRichMarkdownSourceOwningSlice(slice)
  if (status.containsSourceOwningNode && !status.canPreserve) {
    showRichMarkdownSourceOwningCutLimitError()
    return false
  }
  const serialized = serializeRichMarkdownSliceForClipboard(view, slice)
  clipboardData.setData('text/html', serialized.html)
  clipboardData.setData('text/plain', visibleText)
  // Rejected clipboard writes must preserve content and explain why cutting was refused.
  if (
    typeof clipboardData.getData === 'function' &&
    (clipboardData.getData('text/html') !== serialized.html ||
      clipboardData.getData('text/plain') !== visibleText)
  ) {
    showRichMarkdownSourceOwningCutLimitError()
    return false
  }
  return true
}
