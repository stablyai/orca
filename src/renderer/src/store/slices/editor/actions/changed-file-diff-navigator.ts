import type { EditorGet, EditorSet } from '../types/editor-set-get'

export type ChangedFileDiffNavigatorState = {
  // Registered by the Source Control panel; null (panel unmounted) keeps F7 wrapping in-file.
  changedFileDiffNavigator: ((direction: 'next' | 'previous') => boolean) | null
  setChangedFileDiffNavigator: (
    navigator: ((direction: 'next' | 'previous') => boolean) | null
  ) => void
}

export function createChangedFileDiffNavigator(
  set: EditorSet,
  _get: EditorGet
): ChangedFileDiffNavigatorState {
  return {
    changedFileDiffNavigator: null,
    setChangedFileDiffNavigator: (navigator) => set({ changedFileDiffNavigator: navigator })
  }
}
