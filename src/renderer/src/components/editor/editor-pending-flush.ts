type PendingEditor = { flush: () => void; hasChange?: () => boolean }
const pendingEditorFlushes = new Map<string, Set<PendingEditor>>()

export function registerPendingEditorFlush(
  fileId: string,
  flush: () => void,
  hasChange?: () => boolean
): () => void {
  const entry = { flush, hasChange }
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
