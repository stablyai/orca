import type { ExecutionHostId } from '../../../../../../shared/execution-host'

/**
 * Drop a removed row from the local persisted cleanup snapshots.
 *
 * Only a remote delete needs this: local main prunes its own snapshots inline.
 * Without it a remotely removed row resurrects from cache on the next scan.
 */
export async function recordRemovedWorktreeSnapshotPrune(args: {
  worktreeId: string
  hostId: ExecutionHostId | undefined
  snapshotPruneBatchId: string | undefined
}): Promise<void> {
  try {
    await window.api.workspaceCleanup?.recordRemovalSnapshotPrune?.({
      // Why: an unknown batch id degrades to an immediate one-off prune. The id
      // must stay bounded — main rejects batch ids over 128 chars, so it cannot
      // embed the unbounded worktreeId.
      batchId: args.snapshotPruneBatchId ?? `single-removal:${crypto.randomUUID()}`,
      worktreeId: args.worktreeId,
      ...(args.hostId ? { executionHostId: args.hostId } : {})
    })
  } catch (error) {
    console.warn('Failed to record workspace cleanup snapshot prune:', error)
  }
}
