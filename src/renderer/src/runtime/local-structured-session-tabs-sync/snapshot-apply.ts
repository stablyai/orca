import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { markStructuredAgentSessionLaunchesPublished } from '../../lib/structured-agent-session-launch-publication'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner-state'
import { getExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from '../web-session-tabs-sync/store-patch'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync/state'
import {
  admitRetiredValueUnderAuthority,
  noteRetiredValue,
  sameSessionTabsPublicationLineage
} from '../web-session-tabs-sync/publisher-identity-fences'
import { knownStructuredSessionWorktreeIds } from '../local-structured-session-tab-retirement'
import {
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionVersionByWorktree
} from './inventory-generation-fence'
import { forgetRetiredEpochRepairsOutside } from './retired-epoch-repair'
import { projectLocalStructuredSessionTabs } from './snapshot-projection'
import {
  hostSnapshotAffirmsAgentSessions,
  hostSnapshotAffirmsWorktreeContents
} from '../host-session-snapshot-authority'
import { retireAbsentStructuredAgentSessionLaunchCancellationTombstones } from '../../lib/structured-agent-session-launch-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  beginStructuredAgentSessionAuthoritativeInventory,
  startStructuredAgentLaunchCancellationCleanup
} from '../../lib/launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { suppressCancelledStructuredSessionTabs } from '../structured-agent-session-tab-retirement'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import { closeStructuredAgentSession } from '../structured-agent-session-close'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { useAppStore } from '../../store'
import { framesDrawWorkspace } from '../workspace-layout-frame-drawn-workspaces'
import { drawnChatLabelChanges, type DrawnChatLabel } from './frame-drawn-chat-tabs'

/** The host saying it no longer publishes this worktree at all, rather than publishing an empty one. */
function isWorktreeRetraction(
  snapshot: RuntimeMobileSessionTabsResult
): snapshot is RuntimeMobileSessionTabsRemovedResult {
  return (snapshot as Partial<RuntimeMobileSessionTabsRemovedResult>).removed === true
}

export type StructuredSessionSnapshotApplyOptions = {
  /** Authority census replies answer a just-issued listAll, so exempt them from retired-epoch fencing of delayed dead-generation stream frames. */
  authoritative?: boolean
  /** Re-applies a publication at the version already applied: the window removed a chat early. */
  reacceptCurrentVersion?: boolean
  /** Sequence allocated when the inventory request began, before a close can race its reply. */
  authoritativeInventory?: number
  /** Called for each snapshot the retired-epoch fence rejects; the repair lane listens here. */
  onRetiredEpochDrop?: (worktreeId: string, publicationEpoch: string) => void
  /** Collects accepted publications so lifecycle listeners run after the store patch settles. */
  onAcceptedAgentSession?: (worktreeId: string, sessionId: string) => void
  /** Workspaces main's frames draw: the listing writes none of their tabs, only collects labels. */
  framesDraw?: (worktreeId: string) => boolean
  /** Collects host titles for drawn chat tabs, applied as content after the store patch. */
  onDrawnChatLabel?: (change: DrawnChatLabel) => void
}

export function applyStructuredSessionTabSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER,
  options: StructuredSessionSnapshotApplyOptions = {}
): void {
  const acceptedAgentSessions: { worktreeId: string; sessionId: string }[] = []
  const drawnChatLabels: DrawnChatLabel[] = []
  const settleStructuredSessionMirror = applyWebSessionTabsStorePatch(
    (state) =>
      applyLocalStructuredSessionTabSnapshots(state, snapshots, owner, undefined, {
        ...options,
        onAcceptedAgentSession: (worktreeId, sessionId) => {
          acceptedAgentSessions.push({ worktreeId, sessionId })
          options.onAcceptedAgentSession?.(worktreeId, sessionId)
        },
        // Switch point: main places the listed chats' tabs; its frames draw them.
        framesDraw: ORCA_LAYOUT_OWNER_IS_MAIN ? framesDrawWorkspace(state) : undefined,
        onDrawnChatLabel: (change) => drawnChatLabels.push(change)
      }),
    { frames: [] }
  )
  settleStructuredSessionMirror()
  const { setTabLabel } = useAppStore.getState()
  for (const { tabId, label } of drawnChatLabels) {
    setTabLabel(tabId, label)
  }
  markStructuredAgentSessionLaunchesPublished(LOCAL_EXECUTION_HOST_ID, acceptedAgentSessions)
  if (options.authoritative) {
    startStructuredAgentLaunchCancellationCleanup(LOCAL_EXECUTION_HOST_ID, (sessionId) =>
      closeStructuredAgentSession({ kind: 'local' }, sessionId)
    )
  }
  // A chat missing from an inventory that cannot list chats is not proof the host dropped it.
  if (options.authoritative && snapshots.every(hostSnapshotAffirmsAgentSessions)) {
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
      new Set(
        snapshots.flatMap((snapshot) =>
          snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.sessionId)
        )
      ),
      options.authoritativeInventory ?? beginStructuredAgentSessionAuthoritativeInventory(),
      LOCAL_EXECUTION_HOST_ID
    )
  }
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
    // Local inventory must not rewrite paired/SSH panes; execution hosts own their tabs.
    if (getExecutionHostIdForWorktree(next, snapshot.worktree) !== 'local') {
      continue
    }
    // Forced none-epoch placeholders prove no absence: neither apply nor record, which would retire the renderer epoch. Retain cursor to fence genuinely stale frames.
    if (!hostSnapshotAffirmsWorktreeContents(snapshot)) {
      continue
    }
    const prior = localStructuredSessionVersionByWorktree.get(snapshot.worktree)
    const sharesLineage = Boolean(
      prior && sameSessionTabsPublicationLineage(prior.publicationEpoch, snapshot.publicationEpoch)
    )
    const epochHistory = localStructuredSessionEpochHistoryByWorktree.get(snapshot.worktree)
    // Retired epochs can belong to live returning publishers after retraction/headless takeover. They inherit current worktree epoch, so rejection needs authoritative repair rather than assuming death.
    if (
      !sharesLineage &&
      !admitRetiredValueUnderAuthority(
        epochHistory,
        snapshot.publicationEpoch,
        options.authoritative === true
      )
    ) {
      options.onRetiredEpochDrop?.(snapshot.worktree, snapshot.publicationEpoch)
      continue
    }
    if (
      prior &&
      sharesLineage &&
      (options.reacceptCurrentVersion
        ? snapshot.snapshotVersion < prior.snapshotVersion
        : snapshot.snapshotVersion <= prior.snapshotVersion)
    ) {
      continue
    }
    const effectiveSnapshot = suppressCancelledStructuredSessionTabs(snapshot, { kind: 'local' })
    for (const tab of effectiveSnapshot.tabs) {
      if (tab.type === 'agent-session') {
        options.onAcceptedAgentSession?.(snapshot.worktree, tab.sessionId)
      }
    }
    // Runs for a drawn workspace too: its tab-id, focus and close-intent ledgers still follow the host.
    const patch = applyWebSessionTabsSnapshot(
      next,
      projectLocalStructuredSessionTabs(effectiveSnapshot),
      owner,
      now,
      {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      }
    )
    if (options.framesDraw?.(snapshot.worktree)) {
      // Main's frames own this workspace's tabs, so the patch (tab structure only here) is dropped.
      for (const change of drawnChatLabelChanges(
        next.unifiedTabsByWorktree[snapshot.worktree] ?? [],
        effectiveSnapshot
      )) {
        options.onDrawnChatLabel?.(change)
      }
    } else {
      next = patch === next ? next : ({ ...next, ...patch } as State)
    }
    if (isWorktreeRetraction(effectiveSnapshot)) {
      // Retraction removes rows but is not a publication: recording it would retire this consumer/publisher renderer’s lifetime epoch. Retain version cursor against pre-close replies; rebuilt entries mint fresh epochs. Preserve retired tombstones but clear current so the next lineage cannot retire our lifetime epoch one cycle later. Clearing all history would admit dead-epoch stragglers across lineages.
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
  // Deleted worktrees must release publisher cursors instead of retaining them for renderer lifetime.
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
