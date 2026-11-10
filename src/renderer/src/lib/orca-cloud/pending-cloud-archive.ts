// An archive queued after "Move to this computer" (5 s undo window) and a Delete of the same
// workspace race: the archive's sleep then fails against a sandbox Delete is destroying and
// toasts misleading errors. Delete cancels a queued archive and marks the workspace so an archive
// already under way stays quiet.

const queued = new Map<string, () => void>()
const deleting = new Set<string>()

/** The archive's undo window registers its cancel; returns the unregister. */
export function registerQueuedCloudArchive(workspaceId: string, cancel: () => void): () => void {
  queued.set(workspaceId, cancel)
  return () => {
    if (queued.get(workspaceId) === cancel) {
      queued.delete(workspaceId)
    }
  }
}

/** Delete started: cancel a queued archive, and silence one already running. */
export function noteCloudWorkspaceDeleting(workspaceId: string): void {
  deleting.add(workspaceId)
  queued.get(workspaceId)?.()
  queued.delete(workspaceId)
}

export function noteCloudWorkspaceDeleteSettled(workspaceId: string): void {
  deleting.delete(workspaceId)
}

export function isCloudWorkspaceDeleting(workspaceId: string): boolean {
  return deleting.has(workspaceId)
}
