import {
  editorBufferSiblingViewIds,
  type EditorBufferViewIndex
} from '@/store/slices/editor/buffers/editor-buffer-views'

type PendingEditor = { flush: () => void; hasChange?: () => boolean; preserve?: () => void }
const pendingEditorFlushes = new Map<string, Set<PendingEditor>>()

export function registerPendingEditorFlush(
  fileId: string,
  flush: () => void,
  hasChange?: () => boolean,
  /** Keeps pending input as draft text when the view closes and `flush` can't commit it. */
  preserve?: () => void
): () => void {
  const entry = { flush, hasChange, preserve }
  const entries = pendingEditorFlushes.get(fileId) ?? new Set<PendingEditor>()
  entries.add(entry)
  pendingEditorFlushes.set(fileId, entries)
  return () => {
    entries.delete(entry)
    if (!entries.size && pendingEditorFlushes.get(fileId) === entries) {
      pendingEditorFlushes.delete(fileId)
    }
  }
}

function pendingEntriesOf(viewIds: readonly string[]): PendingEditor[] {
  return viewIds.flatMap((viewId) => [...(pendingEditorFlushes.get(viewId) ?? [])])
}

function flushPendingEntries(entries: PendingEditor[], autosave: boolean): void {
  // Keep legacy replacement semantics while retaining each CSV pane's pending input.
  const legacy = entries.findLast((entry) => !entry.hasChange)
  for (const entry of entries) {
    if (entry.hasChange ? !autosave : entry === legacy) {
      entry.flush()
    }
  }
}

/** Flushes pending text from every view of `fileId`'s record. */
export function flushPendingEditorBuffer(
  state: EditorBufferViewIndex,
  fileId: string,
  autosave = false
): void {
  flushPendingEntries(pendingEntriesOf(editorBufferSiblingViewIds(state, fileId)), autosave)
}

export function hasPendingEditorBufferChange(
  state: EditorBufferViewIndex,
  fileId: string
): boolean {
  return pendingEntriesOf(editorBufferSiblingViewIds(state, fileId)).some((entry) =>
    entry.hasChange?.()
  )
}

/** Before closing, flush all panes and shared-record views of these files only; idle panes no-op and unrelated edits continue. */
export function flushClosingEditorBuffers(
  state: EditorBufferViewIndex,
  fileIds: Iterable<string>
): void {
  const entries = new Set<PendingEditor>()
  for (const fileId of fileIds) {
    for (const entry of pendingEntriesOf(editorBufferSiblingViewIds(state, fileId))) {
      entries.add(entry)
    }
  }
  for (const entry of entries) {
    try {
      entry.flush()
    } catch (error) {
      // A failed flush must preserve input without blocking other panes from closing.
      console.error('[editor] flushing pending edits before tabs close failed', error)
      try {
        entry.preserve?.()
      } catch (preserveError) {
        console.error('[editor] preserving pending edits before tabs close failed', preserveError)
      }
    }
  }
}
