import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-exit-deferral'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { readWorkspaceMetadataSet } from '../../../../shared/worktree/metadata/workspace-metadata-set'
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
  // Every repo projection this producer lists here, built only for a gap or a first-seen projection.
  let projections: { repoId: string; hostId: ExecutionHostId }[] | undefined
  let listed: Set<string> | undefined
  const producerProjections = (): { repoId: string; hostId: ExecutionHostId }[] =>
    (projections ??= useAppStore.getState().repos.flatMap((repo) => {
      const hostId = getRepoExecutionHostId(repo)
      return workspaceMetadataProducerKey(hostId) === producerKey
        ? [{ repoId: repo.id, hostId }]
        : []
    }))
  const { replayed, gap } = noteWorkspaceMetadataRecord(
    producerKey,
    set.epoch,
    set.seq,
    set.repoId,
    listingHost,
    (repoId, hostId) =>
      (listed ??= new Set(producerProjections().map((p) => `${p.hostId}\u0000${p.repoId}`))).has(
        `${hostId}\u0000${repoId}`
      )
  )
  if (replayed) {
    return
  }
  let applied = false
  useAppStore.setState((current) => {
    const result = patchWorktreeMetadataSet(current, set, source)
    applied = result.applied
    return result.patch ?? current
  })
  if (gap) {
    // A missed record names no projection: list every one this producer owns here, each once.
    requireWorkspaceMetadataCoverage(producerKey, producerProjections())
    for (const { repoId, hostId } of producerProjections()) {
      requestWorkspaceMetadataRecovery(repoId, hostId, fetchWorktrees)
    }
  } else if (!applied) {
    // The row or a link isn't listed yet; a listing begun now includes this record.
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
