import type { WorkspaceSleepNotice } from '../../../../shared/workspace-sleep'

const listeners = new Set<(notice: WorkspaceSleepNotice) => void>()

/** A paired web client has no main to announce its sleeps; its own sleep call announces them. */
export function subscribeWebWorkspaceSleep(
  listener: (notice: WorkspaceSleepNotice) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitWebWorkspaceSleep(notice: WorkspaceSleepNotice): void {
  for (const listener of listeners) {
    listener(notice)
  }
}
