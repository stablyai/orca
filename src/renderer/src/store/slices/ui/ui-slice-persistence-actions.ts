import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'

export function createUiPersistenceActions(set: UISliceSet, _get: UISliceGet): Partial<UISlice> {
  return {
    persistedUIReady: false,
    persistedUIWriteBaseline: null,
    persistedUIWriteInFlightCounts: {},
    notePersistedUIWriteStarted: (fields) =>
      set((s) => {
        const counts = { ...s.persistedUIWriteInFlightCounts }
        for (const field of fields) {
          counts[field] = (counts[field] ?? 0) + 1
        }
        return { persistedUIWriteInFlightCounts: counts }
      }),
    persistedUIWriteBaselineGeneration: 0,
    notePersistedUIWriteSettled: (fields, flushed, options) =>
      set((s) => {
        const counts = { ...s.persistedUIWriteInFlightCounts }
        for (const field of fields) {
          const next = (counts[field] ?? 0) - 1
          if (next > 0) {
            counts[field] = next
          } else {
            delete counts[field]
          }
        }
        // Fold only with a matching baseline generation; hydration during the round trip supersedes sent values. Skipping stale/unguarded folds preserves the diff for a trailing flush.
        const foldable =
          flushed &&
          s.persistedUIWriteBaseline &&
          options !== undefined &&
          options.sentAtGeneration === s.persistedUIWriteBaselineGeneration
        return {
          persistedUIWriteInFlightCounts: counts,
          ...(foldable
            ? { persistedUIWriteBaseline: { ...s.persistedUIWriteBaseline!, ...flushed } }
            : {})
        }
      }),
    uiZoomLevel: 0,
    setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
    editorFontZoomLevel: 0,
    setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level })
  }
}
