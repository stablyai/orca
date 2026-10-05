type PendingEditorFlush = { flush: () => void; isPending: () => boolean }
const pendingEditorFlushes = new Map<string, Set<PendingEditorFlush>>()
const changeListeners = new Set<(fileId: string) => void>()

export function registerPendingEditorFlush(
  fileId: string,
  flush: () => void,
  isPending: () => boolean = () => false
): () => void {
  const registration = { flush, isPending }
  const registrations = pendingEditorFlushes.get(fileId) ?? new Set<PendingEditorFlush>()
  registrations.add(registration)
  pendingEditorFlushes.set(fileId, registrations)
  return () => {
    registrations.delete(registration)
    if (registrations.size === 0) {
      pendingEditorFlushes.delete(fileId)
    }
  }
}

export function flushPendingEditorChange(fileId: string): void {
  pendingEditorFlushes.get(fileId)?.forEach(({ flush }) => flush())
}

export function flushPendingEditorChanges(): void {
  pendingEditorFlushes.forEach((registrations) => {
    registrations.forEach(({ flush }) => flush())
  })
}

export function hasPendingEditorChange(fileId: string): boolean {
  const registrations = pendingEditorFlushes.get(fileId)
  if (registrations) {
    for (const registration of registrations) {
      if (registration.isPending()) {
        return true
      }
    }
  }
  return false
}

/** Schedule persistence from input time without serializing the text model. */
export function notifyPendingEditorChange(fileId: string): void {
  changeListeners.forEach((listener) => listener(fileId))
}

export function subscribePendingEditorChanges(listener: (fileId: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}
