/**
 * The document range a cut is serializing. `clipboardTextSerializer` has a
 * fixed `(slice, view)` signature, and both hand-rolled cut paths run only for
 * an empty selection — `handleRichMarkdownCut` defers any non-empty selection
 * to ProseMirror — so they expand a caret into a computed range that
 * `view.state.selection` does not span. The range travels here for the
 * duration of that synchronous call.
 */
const state: { range?: { from: number; to: number } } = {}

export const RICH_MARKDOWN_CUT_RANGE = {
  serializingRange<T>(range: { from: number; to: number }, serialize: () => T): T {
    const previous = state.range
    state.range = range
    try {
      return serialize()
    } finally {
      state.range = previous
    }
  },

  current(): { from: number; to: number } | undefined {
    return state.range
  }
}
