export type WorktreeSnapshotPruneBatch = {
  batchId: string
  finish: () => Promise<void>
}

export function beginWorktreeSnapshotPruneBatch(): Promise<WorktreeSnapshotPruneBatch | null> | null {
  if (typeof window === 'undefined') {
    return null
  }
  const api = window.api.workspaceCleanup
  const begin = api.beginRemovalSnapshotPruneBatch
  const record = api.recordRemovalSnapshotPrune
  const finish = api.finishRemovalSnapshotPruneBatch
  if (typeof begin !== 'function' || typeof record !== 'function' || typeof finish !== 'function') {
    return null
  }
  const batchId = crypto.randomUUID()
  return begin({ batchId })
    .then(() => ({ batchId, finish: () => finish({ batchId }) }))
    .catch((error: unknown) => {
      console.warn('Failed to begin workspace snapshot prune batch:', error)
      return null
    })
}
