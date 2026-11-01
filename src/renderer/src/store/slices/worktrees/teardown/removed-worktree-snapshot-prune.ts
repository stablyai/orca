import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'

/** Prune remote removals from local cached cleanup snapshots or they reappear on next scan; local main already prunes inline. */
export async function recordRemovedWorktreeSnapshotPrune(args: {
  worktreeId: string
  hostId: ExecutionHostId | undefined
  snapshotPruneBatchId: string | undefined
}): Promise<void> {
  try {
    await window.api.workspaceCleanup?.recordRemovalSnapshotPrune?.({
      // Unknown batch IDs prune immediately; use bounded UUID key because main caps length at 128 and worktree IDs are unbounded.
      batchId: args.snapshotPruneBatchId ?? `single-removal:${createBrowserUuid()}`,
      worktreeId: args.worktreeId,
      ...(args.hostId ? { executionHostId: args.hostId } : {})
    })
  } catch (error) {
    console.warn('Failed to record workspace cleanup snapshot prune:', error)
  }
}
