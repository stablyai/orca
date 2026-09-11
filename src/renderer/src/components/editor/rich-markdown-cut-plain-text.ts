import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Resolves the plain-text clipboard flavor for the hand-rolled cut paths,
 * which bypass ProseMirror's clipboard serialization. Routing through the
 * view's own `clipboardTextSerializer` keeps cut and copy on one format.
 * Falls back to visible text when no serializer is reachable.
 */
export function resolveRichMarkdownCutPlainText(
  view: EditorView,
  slice: Slice,
  visibleText: string
): string {
  // Why: lightweight unit-test views expose no plugin props.
  if (typeof view.someProp !== 'function') {
    return visibleText
  }
  const serialized = view.someProp('clipboardTextSerializer', (serialize) => serialize(slice, view))
  return typeof serialized === 'string' ? serialized : visibleText
}
