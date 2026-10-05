import type { EditorView } from '@tiptap/pm/view'

export function resolveRichMarkdownCutPlainText(
  view: EditorView,
  visibleText: string,
  range: { from: number; to: number }
): string {
  // Match native copy's parent context without changing the cut's HTML slice.
  const textSlice = view.state.doc.slice(range.from, range.to, true)
  const serialized = view.someProp('clipboardTextSerializer', (serialize) =>
    serialize(textSlice, view)
  )
  return typeof serialized === 'string' ? serialized : visibleText
}
