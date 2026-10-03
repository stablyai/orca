import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { RICH_MARKDOWN_CUT_RANGE } from './rich-markdown-cut-range'

/**
 * Resolves the plain-text clipboard flavor for the hand-rolled cut paths,
 * which bypass ProseMirror's clipboard serialization. Routing through the
 * view's own `clipboardTextSerializer` keeps cut and copy on one format.
 * Falls back to visible text when no serializer is reachable.
 *
 * `range` is the document range the slice was cut from. These paths cut a
 * computed range rather than the current selection, so the serializer cannot
 * read the slice's ancestor off `view.state.selection`.
 */
export function resolveRichMarkdownCutPlainText(
  view: EditorView,
  slice: Slice,
  visibleText: string,
  range: { from: number; to: number }
): string {
  // Why: lightweight unit-test views expose no plugin props.
  if (typeof view.someProp !== 'function') {
    return visibleText
  }
  const serialized = RICH_MARKDOWN_CUT_RANGE.serializingRange(range, () =>
    view.someProp('clipboardTextSerializer', (serialize) => serialize(slice, view))
  )
  return typeof serialized === 'string' ? serialized : visibleText
}
