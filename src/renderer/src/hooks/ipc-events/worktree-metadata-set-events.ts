import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-exit-deferral'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { readWorkspaceMetadataSet } from '../../../../shared/worktree/workspace-metadata-set'
import { useAppStore } from '../../store'
import {
  noteWorkspaceMetadataRecord,
  requireWorkspaceMetadataCoverage,
  workspaceMetadataProducerKey
} from '../../store/slices/worktrees/listing/workspace-metadata-coverage'
import { requestWorkspaceMetadataRecovery } from '../../store/slices/worktrees/listing/workspace-metadata-recovery'
import {
  patchWorktreeMetadataSet,
  type MetadataSetSource
} from '../../store/slices/worktrees/listing/worktree-metadata-set-patch'
import type { WorktreeFetchOptions } from '../../store/slices/worktrees/listing/worktree-fetch-options'

const fetchWorktrees = (repoId: string, options: WorktreeFetchOptions): Promise<unknown> =>
  useAppStore.getState().fetchWorktrees(repoId, options)

function apply(record: unknown, source: MetadataSetSource): void {
  const set = readWorkspaceMetadataSet(record)
  if (!set) {
    return
  }
  // The listing owner for this record's repo: this app (local and SSH rows) or the paired environment.
  const listingHost: ExecutionHostId =
    source.kind === 'environment' ? toRuntimeExecutionHostId(source.environmentId) : set.hostId
  const producerKey = workspaceMetadataProducerKey(listingHost)
  const { replayed, gap } = noteWorkspaceMetadataRecord(producerKey, set.epoch, set.seq, set.repoId)
  if (replayed) {
    return
  }
  let applied = false
  useAppStore.setState((state) => {
    const result = patchWorktreeMetadataSet(state, set, source)
    applied = result.applied
    return result.patch ?? state
  })
  if (gap) {
    // A missed record names no repo: list every repo this producer owns here, each once.
    const repos = useAppStore
      .getState()
      .repos.filter(
        (repo) =>
          workspaceMetadataProducerKey(getRepoExecutionHostId(repo) ?? LOCAL_EXECUTION_HOST_ID) ===
          producerKey
      )
    const repoHosts = new Map(repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)]))
    requireWorkspaceMetadataCoverage(producerKey, repoHosts.keys())
    for (const [repoId, hostId] of repoHosts) {
      requestWorkspaceMetadataRecovery(repoId, hostId, fetchWorktrees)
    }
  } else if (!applied) {
    // The row or link isn't listed yet; a listing begun now includes this record.
    requestWorkspaceMetadataRecovery(set.repoId, listingHost, fetchWorktrees)
  }
}

/** This app's own host: the record names the host its row lives on. */
export function applyLocalWorktreeMetadataSet(record: unknown): void {
  apply(record, { kind: 'local' })
}

/**
 * A paired host's per-workspace row events, after the bridge's connection-generation check.
 * Returns false for any other event.
 */
export function applyHostWorkspaceRowEvent(
  environmentId: string,
  event: RuntimeClientEvent
): boolean {
  if (event.type === 'worktreeTerminalSleepState') {
    applyHostWorktreeTerminalSleepState(environmentId, event)
    return true
  }
  if (event.type === 'workspaceMetadataSet') {
    apply(event, { kind: 'environment', environmentId })
    return true
  }
  return false
}
