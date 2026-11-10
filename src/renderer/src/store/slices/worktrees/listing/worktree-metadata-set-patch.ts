import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceMetadataSet } from '../../../../../../shared/worktree/workspace-metadata-set'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

// Last applied record per producer stream; a replayed or older record is dropped.
const appliedByProducer = new Map<string, { epoch: string; seq: number }>()

/**
 * Applies one producer's addressed `workspaceMetadata` record to the row it names. A row this client
 * has not listed yet is left for its next listing, which already carries the same values.
 */
export function patchWorktreeMetadataSet(
  state: AppState,
  set: WorkspaceMetadataSet,
  // The client's own id for the producing host (a paired server's records arrive as its local rows).
  hostId: ExecutionHostId
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const last = appliedByProducer.get(hostId)
  if (last && last.epoch === set.epoch && set.seq <= last.seq) {
    return state
  }
  appliedByProducer.set(hostId, { epoch: set.epoch, seq: set.seq })
  const listing = selectWorktreesByRepo(state)
  const rows = listing[set.repoId]
  if (!rows) {
    return state
  }
  const matchOptions = worktreeHostMatchOptions(state, set.repoId, hostId)
  const index = rows.findIndex(
    (worktree) =>
      worktree.id === set.worktreeId && worktreeMatchesHost(worktree, hostId, matchOptions)
  )
  if (index === -1) {
    return state
  }
  const next = rows.slice()
  next[index] = { ...rows[index], ...set.row }
  return { worktreesByRepo: { ...listing, [set.repoId]: next } }
}
