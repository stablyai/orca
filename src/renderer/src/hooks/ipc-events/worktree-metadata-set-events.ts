import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { readWorkspaceMetadataSet } from '../../../../shared/worktree/workspace-metadata-set'
import { useAppStore } from '../../store'
import {
  hasPendingIssueTitles,
  patchWorktreeMetadataSet,
  reapplyPendingIssueTitles
} from '../../store/slices/worktrees/listing/worktree-metadata-set-patch'

let listingWatch: (() => void) | null = null

// A listing that read metadata before a record's write may land after it; refill its titles then.
function watchListings(): void {
  listingWatch ??= useAppStore.subscribe((state, previous) => {
    if (state.worktreesByRepo !== previous.worktreesByRepo && hasPendingIssueTitles()) {
      useAppStore.setState(reapplyPendingIssueTitles)
    }
  })
}

function apply(record: unknown, hostIdFor: (recordHostId: ExecutionHostId) => ExecutionHostId) {
  const set = readWorkspaceMetadataSet(record)
  if (!set) {
    return
  }
  watchListings()
  useAppStore.setState((state) => patchWorktreeMetadataSet(state, set, hostIdFor(set.hostId)))
}

/** This app's own host: the record names the host its row lives on. */
export function applyLocalWorktreeMetadataSet(record: unknown): void {
  apply(record, (recordHostId) => recordHostId)
}

/** A paired host's record: its rows live here under that environment's host id. */
export function applyEnvironmentWorktreeMetadataSet(environmentId: string, record: unknown): void {
  apply(record, () => toRuntimeExecutionHostId(environmentId))
}
