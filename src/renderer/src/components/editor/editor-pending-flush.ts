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

/** Resolves false when the view still holds edits it could not hand to the buffer. */
type FrameFlush = () => Promise<boolean>
const frameFlushes = new Map<string, Set<FrameFlush>>()

/** For editors whose pending edits live in another frame, so flushing them is a round trip. */
export function registerEditorFrameFlush(fileId: string, flush: FrameFlush): () => void {
  const entries = frameFlushes.get(fileId) ?? new Set<FrameFlush>()
  entries.add(flush)
  frameFlushes.set(fileId, entries)
  return () => {
    entries.delete(flush)
    if (!entries.size && frameFlushes.get(fileId) === entries) {
      frameFlushes.delete(fileId)
    }
  }
}

/** Flushes every frame view of `fileId`'s record; false if any kept edits back, so a save must
 *  not write the buffer as if it were the latest. */
export async function flushEditorFrames(
  state: EditorBufferViewIndex,
  fileId: string
): Promise<boolean> {
  const flushes = editorBufferSiblingViewIds(state, fileId).flatMap((viewId) => [
    ...(frameFlushes.get(viewId) ?? [])
  ])
  if (flushes.length === 0) {
    return true
  }
  const results = await Promise.all(flushes.map((flush) => flush().catch(() => false)))
  return results.every(Boolean)
}

/** Every view's pending edits, frames first since they land in the buffer as text edits. False
 *  when a frame kept edits back: a save must then not write the buffer as the latest. */
export async function flushEditorViewsForSave(
  getState: () => EditorBufferViewIndex,
  fileId: string,
  autosave = false
): Promise<boolean> {
  const framesFlushed = await flushEditorFrames(getState(), fileId)
  flushPendingEditorBuffer(getState(), fileId, autosave)
  return framesFlushed
}
