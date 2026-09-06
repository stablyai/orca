import type { AppState } from '../types'
import type { DropAgentStatusByTabPrefixOptions } from './agent-status-contract'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import {
  boundRecentlyClosedAgentStatusTabIds,
  boundRecentlyRetiredAgentStatusPaneKeys,
  removePaneKeysByTabPrefix
} from './agent-status-pane-keyed-records'
import { findCompletedOrphanPaneKeysForTabClose } from './agent-status-pane-key-tab-binding'

/** Slices that only the fold touched, so the batch commits as a MERGE. */
export function buildAgentStatusBatchPatch(
  initialState: AppState,
  nextState: AppState
): Partial<AppState> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(nextState) as (keyof AppState)[]) {
    if (!Object.is(nextState[key], initialState[key])) {
      patch[key as string] = nextState[key]
    }
  }
  return patch as Partial<AppState>
}

/** The slice of app state the tab-prefix drop reduces over — narrow so callers
 *  outside the store (the paired snapshot apply) can build the same patch. */
export type AgentStatusTabPrefixDropState = Pick<
  AppState,
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'agentLaunchConfigByPaneKey'
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'migrationUnsupportedByPtyId'
  | 'manuallyUnreadTurnsByPaneKey'
  | 'recentlyClosedAgentStatusTabIds'
  | 'recentlyRetiredAgentStatusPaneKeys'
  | 'retainedAgentsByPaneKey'
  | 'retentionSuppressedPaneKeys'
  | 'sortEpoch'
  | 'tabsByWorktree'
>

/** Pure form of the dropAgentStatusByTabPrefix reducer: the paired snapshot
 *  apply folds the same sweep into a patch it assembles itself, so the two
 *  paths cannot drift. `retiredAliasPaneKeys` comes from the caller because
 *  retiring pane-authority aliases is a registry side effect, not a reduction. */
export function buildAgentStatusTabPrefixDropPatch(
  s: AgentStatusTabPrefixDropState,
  tabIdPrefix: string,
  retiredAliasPaneKeys: readonly string[],
  opts?: DropAgentStatusByTabPrefixOptions
): { patch: Partial<AgentStatusTabPrefixDropState>; hadLive: boolean } {
  const prefix = `${tabIdPrefix}:`
  let hadLive = false
  const buildPatch = (): Partial<AgentStatusTabPrefixDropState> => {
    const completedOrphanKeys = findCompletedOrphanPaneKeysForTabClose(s, opts?.worktreeId, prefix)
    const completedOrphanKeySet = new Set(completedOrphanKeys)
    const liveKeys = [
      ...Object.keys(s.agentStatusByPaneKey).filter((k) => k.startsWith(prefix)),
      ...completedOrphanKeys
    ]
    const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
      (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
    )
    const retainedKeys = Object.keys(s.retainedAgentsByPaneKey).filter(
      (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
    )
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) => entry.paneKey?.startsWith(prefix) ?? false
    )
    // See removeAgentStatus for ack-cleanup rationale; ack entries are owned by the pane lifecycle regardless of live/retained state.
    let nextAck = s.acknowledgedAgentsByPaneKey
    const ackKeys = Object.keys(nextAck).filter(
      (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
    )
    if (ackKeys.length > 0) {
      nextAck = { ...nextAck }
      for (const k of ackKeys) {
        delete nextAck[k]
      }
    }
    const nextClosedTabs = boundRecentlyClosedAgentStatusTabIds(
      s.recentlyClosedAgentStatusTabIds,
      tabIdPrefix
    )
    const nextRetiredPaneKeys = boundRecentlyRetiredAgentStatusPaneKeys(
      s.recentlyRetiredAgentStatusPaneKeys,
      retiredAliasPaneKeys
    )
    const nextClearedAt = opts?.preserveActivityClearedState
      ? s.activityClearedAtByPaneKey
      : removePaneKeysByTabPrefix(s.activityClearedAtByPaneKey, tabIdPrefix, completedOrphanKeySet)
    const nextManualUnread = opts?.preserveActivityClearedState
      ? s.manuallyUnreadTurnsByPaneKey
      : removePaneKeysByTabPrefix(
          s.manuallyUnreadTurnsByPaneKey,
          tabIdPrefix,
          completedOrphanKeySet
        )

    if (
      liveKeys.length === 0 &&
      launchConfigKeys.length === 0 &&
      retainedKeys.length === 0 &&
      !migrationUnsupported.changed
    ) {
      if (nextAck !== s.acknowledgedAgentsByPaneKey) {
        return {
          acknowledgedAgentsByPaneKey: nextAck,
          ...(nextClearedAt !== s.activityClearedAtByPaneKey
            ? { activityClearedAtByPaneKey: nextClearedAt }
            : {}),
          ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
            ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
            : {}),
          recentlyClosedAgentStatusTabIds: nextClosedTabs,
          recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys
        }
      }
      return {
        recentlyClosedAgentStatusTabIds: nextClosedTabs,
        recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys,
        ...(nextClearedAt !== s.activityClearedAtByPaneKey
          ? { activityClearedAtByPaneKey: nextClearedAt }
          : {}),
        ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
          ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
          : {})
      }
    }
    hadLive = liveKeys.length > 0

    const nextLive = liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    for (const key of liveKeys) {
      delete nextLive[key]
    }
    const nextLaunchConfigs =
      launchConfigKeys.length > 0
        ? { ...s.agentLaunchConfigByPaneKey }
        : s.agentLaunchConfigByPaneKey
    for (const key of launchConfigKeys) {
      delete nextLaunchConfigs[key]
    }

    const nextRetained =
      retainedKeys.length > 0 ? { ...s.retainedAgentsByPaneKey } : s.retainedAgentsByPaneKey
    for (const key of retainedKeys) {
      delete nextRetained[key]
    }

    // Why: a suppressor is only consumed on a live→gone transition, so plant one only for live paneKeys and skip already-suppressed and completed-orphan keys — otherwise it leaks (mirrors dropAgentStatus).
    const suppressorAdds = liveKeys.filter(
      (k) => !completedOrphanKeySet.has(k) && !(k in s.retentionSuppressedPaneKeys)
    )
    let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
    if (suppressorAdds.length > 0) {
      nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
      for (const key of suppressorAdds) {
        nextRetentionSuppressedPaneKeys[key] = true
      }
    }

    return {
      agentStatusByPaneKey: nextLive,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      retainedAgentsByPaneKey: nextRetained,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
      recentlyClosedAgentStatusTabIds: nextClosedTabs,
      recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      ...(nextClearedAt !== s.activityClearedAtByPaneKey
        ? { activityClearedAtByPaneKey: nextClearedAt }
        : {}),
      ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
        ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
        : {}),
      // Why: mirrors removeAgentStatusByTabPrefix — only bump epochs when the live map changed; retained-only sweeps don't affect sort/freshness.
      agentStatusEpoch:
        hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
    }
  }
  const patch = buildPatch()
  return { patch, hadLive }
}
