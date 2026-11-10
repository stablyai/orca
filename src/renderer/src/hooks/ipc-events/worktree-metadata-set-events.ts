import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { readWorkspaceMetadataSet } from '../../../../shared/worktree/workspace-metadata-set'
import { useAppStore } from '../../store'
import { patchWorktreeMetadataSet } from '../../store/slices/worktrees/listing/worktree-metadata-set-patch'

/** This app's own host: the record names the host its row lives on. */
export function applyLocalWorktreeMetadataSet(record: unknown): void {
  const set = readWorkspaceMetadataSet(record)
  if (set) {
    useAppStore.setState((state) => patchWorktreeMetadataSet(state, set, set.hostId))
  }
}

/** A paired host's record: its rows live here under that environment's host id. */
export function applyEnvironmentWorktreeMetadataSet(environmentId: string, record: unknown): void {
  const set = readWorkspaceMetadataSet(record)
  if (set) {
    const hostId = toRuntimeExecutionHostId(environmentId)
    useAppStore.setState((state) => patchWorktreeMetadataSet(state, set, hostId))
  }
}
