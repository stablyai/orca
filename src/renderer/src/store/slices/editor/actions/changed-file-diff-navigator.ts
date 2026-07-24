import type { EditorGet, EditorSet } from '../types/editor-set-get'

export type ChangedFileDiffNavigatorState = {
  // Advances the diff review to the adjacent changed file (returns true if it
  // moved). Registered by the Source Control panel, which owns the visible,
  // ordered file list; null when that panel is unmounted, so F7/Shift+F7 fall
  // back to same-file change wrap.
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
