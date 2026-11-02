import type { editor, ISelection } from 'monaco-editor'

// Twenty entries covers typical recent files; eviction only loses scroll position, not correctness.
const CACHE_MAX_ENTRIES = 20

/** Bound module-scoped maps with insertion-order LRU, evicting one oldest entry after each set. Consumers may supply their own limit. */
export function setWithLRU<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = CACHE_MAX_ENTRIES
): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > maxEntries) {
    // Use iterator.done: undefined can be a valid generic Map key and must still be evicted.
    const first = map.keys().next()
    if (!first.done) {
      map.delete(first.value)
    }
  }
}

// Module maps preserve positions across remount without broadcasting store updates on every scroll.
export const scrollTopCache = new Map<string, number>()

// Keep cursor/selection changes outside Zustand for the same no-rerender reason.
export const editorSelectionCache = new Map<string, readonly ISelection[]>()

// Store pdf.js user-space locations; pixel offsets drift when pane width/zoom rebuilds page layout.
export type PdfViewPosition = { pageNumber: number; top: number; left: number }
export const pdfViewPositionCache = new Map<string, PdfViewPosition>()

// Persist playback seconds across media-tab unmounts so return does not restart the clip.
export const mediaPlaybackPositionCache = new Map<string, number>()

// Monaco diff view state includes both cursors/selections and model state; preserve that context beyond numeric scrolling, as VS Code does.
export const diffViewStateCache = new Map<string, editor.IDiffEditorViewState>()

// Full Monaco view state carries folds and horizontal scroll that scrollTop/selection caches miss.
export const editorViewStateCache = new Map<string, editor.ICodeEditorViewState>()
