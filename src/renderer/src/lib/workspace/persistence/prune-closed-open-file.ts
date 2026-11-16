import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

type PartitionSessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
  /** Enumerate persisted partitions; absent on older mains, where only local is pruned. */
  listHostIds?: () => Promise<ExecutionHostId[]>
}

export type { PartitionSessionApi }

export type PruneClosedOpenFileArgs = {
  worktreeId: string
  filePath: string
}

function pruneOpenFilesByWorktree(
  slice: WorkspaceSessionState,
  { worktreeId, filePath }: PruneClosedOpenFileArgs
): WorkspaceSessionState | null {
  const rows = slice.openFilesByWorktree?.[worktreeId]
  if (!rows || !rows.some((row) => row.filePath === filePath)) {
    return null
  }
  const kept = rows.filter((row) => row.filePath !== filePath)
  const openFilesByWorktree = { ...slice.openFilesByWorktree }
  if (kept.length > 0) {
    openFilesByWorktree[worktreeId] = kept
  } else {
    delete openFilesByWorktree[worktreeId]
  }
  return { ...slice, openFilesByWorktree }
}

/**
 * A closed editor file must not survive in host partitions the workspace no longer runs on. A
 * superseded partition's stale `openFilesByWorktree` row (with any `dirtyDraftContent`) re-
 * materializes the tab at the next hydration, so a "Don't Save" close that only clears the
 * current partition's state loses to the residue (#42761). Prune the same
 * `(worktreeId, filePath)` row from every partition that still holds it.
 */
export async function pruneClosedOpenFileFromAllPartitions(
  api: PartitionSessionApi,
  args: PruneClosedOpenFileArgs
): Promise<void> {
  const hostIds: ExecutionHostId[] = [LOCAL_EXECUTION_HOST_ID]
  try {
    for (const hostId of (await api.listHostIds?.()) ?? []) {
      if (!hostIds.includes(hostId)) {
        hostIds.push(hostId)
      }
    }
  } catch (err) {
    console.warn('[session] partition census failed while pruning a closed file:', err)
  }
  await Promise.all(
    hostIds.map(async (hostId) => {
      try {
        const pruned = pruneOpenFilesByWorktree(await api.get(hostId), args)
        if (pruned) {
          await api.set(pruned, hostId)
        }
      } catch (err) {
        // A stale partition must never break the close; the owning partition's write still drops its row.
        console.warn(`[session] pruning the closed file from partition ${hostId} failed:`, err)
      }
    })
  )
}
