const pendingEditorFlushes = new Map<string, () => void>()

export function registerPendingEditorFlush(fileId: string, flush: () => void): () => void {
  pendingEditorFlushes.set(fileId, flush)
  return () => {
    if (pendingEditorFlushes.get(fileId) === flush) {
      pendingEditorFlushes.delete(fileId)
    }
  }
}

export function flushPendingEditorChange(fileId: string): void {
  pendingEditorFlushes.get(fileId)?.()
}
