import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-exit-deferral'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { readWorkspaceMetadataSet } from '../../../../shared/worktree/workspace-metadata-set'
import { useAppStore } from '../../store'
import { selectWorktreesByRepo } from '../../store/workspaces/catalog/workspace-record-fields'
import { getRuntimeEnvironmentRevision } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../../store/slices/runtime-status/runtime-status-connection-generation'
import {
  hasPendingIssueTitles,
  patchWorktreeMetadataSet,
  reapplyPendingIssueTitles,
  type MetadataSetSource
} from '../../store/slices/worktrees/listing/worktree-metadata-set-patch'

let listingWatch: (() => void) | null = null

// A listing that read metadata before a record's write may land after it; refill its titles then.
function watchListings(): void {
  listingWatch ??= useAppStore.subscribe((state, previous) => {
    if (
      selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous) &&
      hasPendingIssueTitles()
    ) {
      useAppStore.setState(reapplyPendingIssueTitles(state, previous))
    }
  })
}

function apply(record: unknown, source: MetadataSetSource): void {
  const set = readWorkspaceMetadataSet(record)
  if (!set) {
    return
  }
  watchListings()
  useAppStore.setState((state) => patchWorktreeMetadataSet(state, set, source))
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
    const revision = getRuntimeEnvironmentRevision(environmentId)
    const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
    apply(event, {
      kind: 'environment',
      environmentId,
      // A re-pair or reconnect retires these titles; the new producer sends its own.
      isCurrent: () =>
        getRuntimeEnvironmentRevision(environmentId) === revision &&
        getRuntimeEnvironmentConnectionGeneration(environmentId) === generation
    })
    return true
  }
  return false
}
