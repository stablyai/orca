import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { serializeRichMarkdownSliceForClipboard } from './rich-markdown-clipboard-serialization'
import { inspectRichMarkdownSourceOwningSlice } from './rich-markdown-source-owning-slice'
import { showRichMarkdownSourceOwningCutLimitError } from './rich-markdown-source-owning-cut-feedback'

/**
 * Writes a rich-markdown slice to the clipboard (HTML + plain), verifying
 * readback. Returns false when the write must not be followed by a delete
 * (source-owning limit or clipboard rejection).
 */
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
  // Why: if the clipboard rejected the write we must not delete, and we must
  // surface the same cut-limit feedback so the no-op is not silent.
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
