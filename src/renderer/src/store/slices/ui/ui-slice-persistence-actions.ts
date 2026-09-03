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
        // Why the generation guard: a hydration during the round trip made the
        // baseline authoritative for state NEWER than this write; folding the
        // sent values over it would blank the mirror-vs-baseline diff and leave
        // mirror and authority divergent with nothing left to reconcile them.
        // Skipping the fold keeps the diff alive so the trailing flush re-sends.
        // Why options is required for folding: an unguarded fold from a future
        // caller could silently erase a remote write that landed mid-round-trip.
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
