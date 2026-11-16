import type { EditorLineEnding } from '../../../../../../shared/editor/saving/editor-end-of-line'

type NewModelLineEndingState = {
  /** Line breaks the user did not type (loaded or written in); such a model keeps its ending. */
  foreignLineBreaks: boolean
  /** Last ending chosen for this model; only a new choice may convert lines already typed. */
  applied: EditorLineEnding | null
}

// Why per model: retained models outlive editor mounts and are shared by split panes.
const states = new WeakMap<object, NewModelLineEndingState>()

/** First sight records whether the model arrived with line breaks. */
export function newModelLineEndingState(model: {
  getLineCount(): number
}): NewModelLineEndingState {
  let state = states.get(model)
  if (!state) {
    state = { foreignLineBreaks: model.getLineCount() > 1, applied: null }
    states.set(model, state)
  }
  return state
}

/** Called by every path that writes outside text into a model, mounted or not. */
export function markForeignLineBreaks(model: object): void {
  const state = states.get(model)
  if (state) {
    state.foreignLineBreaks = true
  } else {
    states.set(model, { foreignLineBreaks: true, applied: null })
  }
}
