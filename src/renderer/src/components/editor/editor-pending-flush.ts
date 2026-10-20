type PendingEditor = {
  flush: () => void
  hasChange?: () => boolean
  /** For a view that serializes its whole document: when its pending edit was made, else null. */
  wholeDocumentEditedAt?: () => number | null
}
const pendingEditorFlushes = new Map<string, Set<PendingEditor>>()

let editSequence = 0
/** Orders pending edits across views; later edits get larger numbers. */
export function nextEditorEditSequence(): number {
  editSequence += 1
  return editSequence
}

export function registerPendingEditorFlush(
  fileId: string,
  flush: () => void,
  hasChange?: () => boolean,
  wholeDocumentEditedAt?: () => number | null
): () => void {
  const entry = { flush, hasChange, wholeDocumentEditedAt }
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

export function flushPendingEditorChange(fileId: string, autosave = false): void {
  const entries = [...(pendingEditorFlushes.get(fileId) ?? [])]
  // Keep legacy replacement semantics while retaining each CSV pane's pending input.
  const legacy = entries.findLast((entry) => !entry.hasChange)
  for (const entry of entries) {
    if (entry.hasChange ? !autosave : entry === legacy) {
      entry.flush()
    }
  }
}

export function hasPendingEditorChange(fileId: string): boolean {
  return [...(pendingEditorFlushes.get(fileId) ?? [])].some((entry) => entry.hasChange?.())
}

/** Pending whole-document serializations of a tab, each with when it was edited. */
export function pendingWholeDocumentEdits(
  fileId: string
): { editedAt: number; flush: () => void }[] {
  return [...(pendingEditorFlushes.get(fileId) ?? [])].flatMap((entry) => {
    const editedAt = entry.wholeDocumentEditedAt?.()
    return editedAt === null || editedAt === undefined ? [] : [{ editedAt, flush: entry.flush }]
  })
}
