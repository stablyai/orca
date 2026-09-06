import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import { getExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch
} from '../web-session-tabs-sync'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync'
import {
  noteRetiredValue,
  sameSessionTabsPublicationLineage
} from '../web-session-tabs-sync/publisher-identity-fences'
import {
  knownStructuredSessionWorktreeIds,
  removeStructuredSessionTabsForVersions
} from '../local-structured-session-tab-retirement'
import {
  dropLocalStructuredSessionRestoreLatch,
  forgetLocalStructuredSessionPublicationCursors,
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionVersionByWorktree,
  supersedeLocalStructuredSessionGeneration
} from './inventory-generation-fence'
import { projectLocalStructuredSessionTabs } from './snapshot-projection'

export const LOCAL_STRUCTURED_SESSION_OWNER = 'local-structured-session'

export function applyStructuredSessionTabSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER
): void {
  const settleStructuredSessionMirror = applyWebSessionTabsStorePatch(
    (state) => applyLocalStructuredSessionTabSnapshots(state, snapshots, owner),
    { frames: [] }
  )
  settleStructuredSessionMirror()
}

export function removeLocalStructuredSessionTabs<
  State extends WebSessionTabsSyncState & WorktreeRuntimeOwnerState
>(state: State, owner = LOCAL_STRUCTURED_SESSION_OWNER, now = Date.now()): State {
  return removeStructuredSessionTabsForVersions(
    state,
    localStructuredSessionVersionByWorktree,
    owner,
    now
  )
}

export function clearLocalStructuredSessionTabs(): void {
  // Fence responses from the previous enabled instance before clearing its mirror.
  supersedeLocalStructuredSessionGeneration()
  const settleStructuredSessionClear = applyWebSessionTabsStorePatch(
    (state) => removeLocalStructuredSessionTabs(state),
    { frames: [] }
  )
  settleStructuredSessionClear()
  dropLocalStructuredSessionRestoreLatch()
  forgetLocalStructuredSessionPublicationCursors()
}

export function applyLocalStructuredSessionTabSnapshots<
  State extends WebSessionTabsSyncState & WorktreeRuntimeOwnerState
>(
  state: State,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER,
  now = Date.now()
): State {
  let next = state
  for (const snapshot of snapshots) {
    // Why: the execution host owns its tabs; local inventory must not rewrite paired or SSH panes.
    if (getExecutionHostIdForWorktree(next, snapshot.worktree) !== 'local') {
      continue
    }
    const prior = localStructuredSessionVersionByWorktree.get(snapshot.worktree)
    const sharesLineage = Boolean(
      prior && sameSessionTabsPublicationLineage(prior.publicationEpoch, snapshot.publicationEpoch)
    )
    const epochHistory = localStructuredSessionEpochHistoryByWorktree.get(snapshot.worktree)
    if (epochHistory?.retired.includes(snapshot.publicationEpoch) && !sharesLineage) {
      continue
    }
    if (prior && sharesLineage && snapshot.snapshotVersion <= prior.snapshotVersion) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(
      next,
      projectLocalStructuredSessionTabs(snapshot),
      owner,
      now,
      {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      }
    )
    next = patch === next ? next : ({ ...next, ...patch } as State)
    localStructuredSessionVersionByWorktree.set(snapshot.worktree, {
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion
    })
    localStructuredSessionEpochHistoryByWorktree.set(
      snapshot.worktree,
      noteRetiredValue(epochHistory, snapshot.publicationEpoch, 8)
    )
  }
  // Drop publisher cursors for worktrees that no longer exist. Without this,
  // every deleted worktree leaves an entry for the lifetime of the renderer.
  const knownWorktreeIds = knownStructuredSessionWorktreeIds(next)
  for (const worktreeId of localStructuredSessionVersionByWorktree.keys()) {
    if (!knownWorktreeIds.has(worktreeId)) {
      localStructuredSessionVersionByWorktree.delete(worktreeId)
      localStructuredSessionEpochHistoryByWorktree.delete(worktreeId)
    }
  }
  return next
}
