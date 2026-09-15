import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import { getExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch
} from '../web-session-tabs-sync'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync'
import {
  hasRetiredValue,
  noteRetiredValue,
  reviveRetiredValue,
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
import { forgetRetiredEpochRepairsOutside } from './retired-epoch-repair'
import { projectLocalStructuredSessionTabs } from './snapshot-projection'
import { hostSnapshotAffirmsWorktreeContents } from '../host-session-snapshot-authority'

export const LOCAL_STRUCTURED_SESSION_OWNER = 'local-structured-session'

/** The host saying it no longer publishes this worktree at all, rather than publishing an empty one. */
function isWorktreeRetraction(
  snapshot: RuntimeMobileSessionTabsResult
): snapshot is RuntimeMobileSessionTabsRemovedResult {
  return (snapshot as Partial<RuntimeMobileSessionTabsRemovedResult>).removed === true
}

export type StructuredSessionSnapshotApplyOptions = {
  /**
   * Marks these snapshots as an authoritative `session.tabs.listAll` response, which exempts them
   * from the retired-epoch fence. A census is the synchronous answer to a request we just issued,
   * so it cannot be the delayed frame from a dead generation that the fence exists to reject —
   * whereas a subscription frame can be, and stays fenced.
   */
  authoritative?: boolean
  /** Called for each snapshot the retired-epoch fence rejects; the repair lane listens here. */
  onRetiredEpochDrop?: (worktreeId: string, publicationEpoch: string) => void
}

export function applyStructuredSessionTabSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER,
  options: StructuredSessionSnapshotApplyOptions = {}
): void {
  const settleStructuredSessionMirror = applyWebSessionTabsStorePatch(
    (state) => applyLocalStructuredSessionTabSnapshots(state, snapshots, owner, undefined, options),
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
  now = Date.now(),
  options: StructuredSessionSnapshotApplyOptions = {}
): State {
  let next = state
  for (const snapshot of snapshots) {
    // Why: the execution host owns its tabs; local inventory must not rewrite paired or SSH panes.
    if (getExecutionHostIdForWorktree(next, snapshot.worktree) !== 'local') {
      continue
    }
    // "Ask me later", not an answer: a worktree the host holds no entry for still answers a forced
    // inventory, with `none` at version 0. Absence there proves nothing, so it neither applies nor
    // records — recording it would retire the epoch below. Its cursor is left alone, so a genuinely
    // stale frame arriving late is still fenced.
    if (!hostSnapshotAffirmsWorktreeContents(snapshot)) {
      continue
    }
    const prior = localStructuredSessionVersionByWorktree.get(snapshot.worktree)
    const sharesLineage = Boolean(
      prior && sameSessionTabsPublicationLineage(prior.publicationEpoch, snapshot.publicationEpoch)
    )
    const epochHistory = localStructuredSessionEpochHistoryByWorktree.get(snapshot.worktree)
    // Why not just drop: an epoch is retired whenever another publisher takes over the worktree,
    // but a live publisher can return after transient interlopers (a `removed:` retraction, then a
    // headless rebuild), and the structured publish inherits the worktree's existing epoch rather
    // than minting its own. So a retired epoch is not proof of a dead generation — only authority
    // can settle it, and the repair lane goes and asks.
    if (hasRetiredValue(epochHistory, snapshot.publicationEpoch) && !sharesLineage) {
      if (!options.authoritative) {
        options.onRetiredEpochDrop?.(snapshot.worktree, snapshot.publicationEpoch)
        continue
      }
      reviveRetiredValue(epochHistory, snapshot.publicationEpoch)
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
    if (isWorktreeRetraction(snapshot)) {
      // A retraction was applied above — the mirrored rows must go — but it is not a publication
      // to fence later frames against. Recording it would retire the renderer's own epoch, which
      // is one string for the whole process lifetime, and every republication afterwards would be
      // dropped until a reload minted a new one. That is what left a revealed chat invisible.
      //
      // The cursor stays: the host mints a fresh epoch when it rebuilds a pruned entry, so a
      // republication is never gated by it, while dropping it would leave a frame issued before
      // the close free to land afterwards and strand a row nothing republishes.
      //
      // The history keeps its tombstones but forgets what is current. Unlike the mainstream path —
      // where the epochs belong to a remote publisher — here the consumer IS the publisher, and
      // `current` is the renderer's own lifetime epoch: leave it set and the next frame under any
      // other epoch retires it for good, which is this bug again one cycle later. Clearing the
      // whole record would instead let a delayed frame from an already-superseded epoch back in,
      // because the version cursor only fences within a lineage. Dropping `current` alone does
      // neither: `noteRetiredValue` retires nothing when there is nothing current.
      const history = localStructuredSessionEpochHistoryByWorktree.get(snapshot.worktree)
      if (history) {
        localStructuredSessionEpochHistoryByWorktree.set(snapshot.worktree, {
          current: null,
          retired: history.retired
        })
      }
      continue
    }
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
  forgetRetiredEpochRepairsOutside(knownWorktreeIds)
  return next
}
