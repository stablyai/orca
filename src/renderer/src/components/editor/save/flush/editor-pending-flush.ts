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

type FrameDiscard = () => void
const frameDiscards = new Map<string, Set<FrameDiscard>>()

/** What a frame-flush wait concluded: `blocked` names files whose frame still held edits it could
 *  not hand over, so a close must prompt instead of dropping them. */
export type EditorFrameFlushResult = {
  deferred: boolean
  blocked: ReadonlySet<string>
}

const NO_BLOCKED_FILES: ReadonlySet<string> = new Set()

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

/** An explicit discard drops what this view's frame still holds, so it cannot be re-applied on unmount. */
export function registerEditorFrameDiscard(fileId: string, discard: FrameDiscard): () => void {
  const entries = frameDiscards.get(fileId) ?? new Set<FrameDiscard>()
  entries.add(discard)
  frameDiscards.set(fileId, entries)
  return () => {
    entries.delete(discard)
    if (!entries.size && frameDiscards.get(fileId) === entries) {
      frameDiscards.delete(fileId)
    }
  }
}

/** Every frame view of these files drops what it still holds; a discard must leave nothing to re-apply. */
export function discardEditorFrames(fileIds: Iterable<string>): void {
  for (const fileId of fileIds) {
    for (const discard of frameDiscards.get(fileId) ?? []) {
      discard()
    }
  }
}

const ownFrameFlushes = (fileId: string): FrameFlush[] => [
  ...(frameFlushes.get(fileId) ?? new Set<FrameFlush>())
]

/** Flushes every frame view of `fileId`'s record; false if any kept edits back, so a save must
 *  not write the buffer as if it were the latest. */
export async function flushEditorFrames(
  state: EditorBufferViewIndex,
  fileId: string
): Promise<boolean> {
  const flushes = frameFlushesOf(state, fileId)
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

function frameFlushesOf(state: EditorBufferViewIndex, fileId: string): FrameFlush[] {
  return editorBufferSiblingViewIds(state, fileId).flatMap((viewId) => [
    ...(frameFlushes.get(viewId) ?? [])
  ])
}

/** Whether closing `fileId` must first wait on its own mounted frame view's flush. */
export function hasEditorFrameFlush(fileId: string): boolean {
  return ownFrameFlushes(fileId).length > 0
}

/** Runs `run` (a close or view switch that unmounts frames) once every frame view of these files
 *  handed over its pending edits, so a dirty check sees them; synchronous when none is mounted, else
 *  `deferred` (re-check what is still open). `result.blocked` reports files whose own frame kept
 *  edits back, so a close can prompt instead of silently dropping them. Each flush has its own
 *  deadline; a sibling view's frame answers for its own tab, not for this one. */
export function runAfterEditorFramesFlush(
  fileIds: Iterable<string>,
  run: (result: EditorFrameFlushResult) => void
): void {
  const framed = [...new Set(fileIds)].filter((fileId) => ownFrameFlushes(fileId).length > 0)
  if (framed.length === 0) {
    run({ deferred: false, blocked: NO_BLOCKED_FILES })
    return
  }
  void Promise.all(
    framed.map(async (fileId) => {
      const results = await Promise.all(
        ownFrameFlushes(fileId).map((flush) => flush().catch(() => false))
      )
      return results.every(Boolean) ? null : fileId
    })
  ).then((settled) =>
    run({
      deferred: true,
      blocked: new Set(settled.filter((fileId): fileId is string => fileId !== null))
    })
  )
}
