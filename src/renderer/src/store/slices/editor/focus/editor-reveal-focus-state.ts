import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'

export function createEditorRevealFocusState(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'pendingEditorReveal'
  | 'setPendingEditorReveal'
  | 'pendingEditorFocusRequest'
  | 'consumeEditorFocusRequest'
> {
  return {
    pendingEditorReveal: null,
    setPendingEditorReveal: (reveal) => set({ pendingEditorReveal: reveal }),
    pendingEditorFocusRequest: null,
    consumeEditorFocusRequest: (token) =>
      set((s) =>
        s.pendingEditorFocusRequest?.token === token ? { pendingEditorFocusRequest: null } : s
      )
  }
}
