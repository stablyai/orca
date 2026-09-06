import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AgentStatusCacheIdentity } from '../../../../shared/agent-status-types'
import { threadStatusGroupId } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'

export type ClearCompletedActivityPlan = {
  /** Panes whose activity gets a cleared-at cutoff stamped. */
  cutoffPatch: Record<string, number | null>
  /** Exact prior cutoff values (or null when absent) so undo restores byte-for-byte. */
  restorePatch: Record<string, number | null>
  /** Retained snapshots removed by the clear; undo re-retains them verbatim. */
  retainedSnapshots: RetainedAgentEntry[]
  /** Exact status identities cleared so deferred disk eviction cannot remove a later run. */
  cacheIdentities: AgentStatusCacheIdentity[]
  clearedThreadCount: number
}

/** A thread is clearable when it needs nothing from the user: completed or interrupted,
 *  with no fresh live working/monitoring/blocked/waiting state. */
export function isClearableActivityThread(thread: AgentPaneThread): boolean {
  const groupId = threadStatusGroupId(thread)
  return groupId === 'done' || groupId === 'interrupted'
}

export function planClearCompletedActivity(
  threads: readonly AgentPaneThread[],
  state: {
    activityClearedAtByPaneKey: Record<string, number>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  },
  now: number = Date.now()
): ClearCompletedActivityPlan {
  const cutoffPatch: Record<string, number | null> = {}
  const restorePatch: Record<string, number | null> = {}
  const retainedSnapshots: RetainedAgentEntry[] = []
  const cacheIdentities: AgentStatusCacheIdentity[] = []
  let clearedThreadCount = 0
  for (const thread of threads) {
    if (!isClearableActivityThread(thread)) {
      continue
    }
    clearedThreadCount += 1
    const previousCutoff = state.activityClearedAtByPaneKey[thread.paneKey] ?? null
    const latestCutoff = Math.max(previousCutoff ?? 0, thread.latestTimestamp)
    // Why `now` for an unstamped thread: the hydrate sanitizer drops non-positive cutoffs, so a
    // zero cutoff would replay the cleared thread after restart.
    cutoffPatch[thread.paneKey] = latestCutoff > 0 ? latestCutoff : now
    restorePatch[thread.paneKey] = previousCutoff
    const retained = state.retainedAgentsByPaneKey[thread.paneKey]
    if (retained) {
      retainedSnapshots.push(retained)
      const entry = retained.entry
      // updatedAt mirrors the wire receivedAt; renderer-enriched fields (connectionId,
      // worktreeId) diverge from main's cache and are deliberately excluded.
      cacheIdentities.push({
        paneKey: thread.paneKey,
        receivedAt: entry.updatedAt,
        stateStartedAt: entry.stateStartedAt
      })
    }
  }
  return { cutoffPatch, restorePatch, retainedSnapshots, cacheIdentities, clearedThreadCount }
}

// Deferred evictions whose undo toast is still open; flushed on pagehide because the toast's
// close callbacks never fire on quit/reload, which would let cleared rows replay next launch.
const pendingDiskEvictions = new Set<() => void>()
export function flushPendingClearCompletedEvictions(): void {
  // Set iteration tolerates the self-delete each evict() performs.
  for (const evict of pendingDiskEvictions) {
    evict()
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingClearCompletedEvictions)
}

// Why a fallback: sonner only fires onDismiss/onAutoClose for the toast's own close paths; a
// `toast.dismiss()` from another caller leaves the eviction pending until pagehide.
export const CLEAR_COMPLETED_EVICTION_FALLBACK_MS = 60_000

function evictPersistedStatuses(identities: readonly AgentStatusCacheIdentity[]): void {
  const api = window.api?.agentStatus
  if (!api || identities.length === 0) {
    return
  }
  if (api.dropPersistedBatch) {
    api.dropPersistedBatch(identities)
    return
  }
  for (const identity of identities) {
    api.dropPersisted?.(identity)
  }
}

/**
 * Clear completed/interrupted activity threads with an undo window.
 *
 * Live agent status, resume identity, and attention/working rows are untouched:
 * clearing stamps per-pane cutoffs (persisted UI) and removes retained completed
 * snapshots. The identity-checked main-process cache eviction is deferred until
 * the undo toast closes so Undo can restore everything losslessly.
 */
export function clearCompletedActivity(threads: readonly AgentPaneThread[]): boolean {
  const state = useAppStore.getState()
  const plan = planClearCompletedActivity(threads, state)
  if (plan.clearedThreadCount === 0) {
    return false
  }
  state.applyActivityClearedAt(plan.cutoffPatch)
  // Why turn timestamps, not entry identity: a runtime orchestration merge replaces the live
  // entry object without a state change (setRuntimeAgentOrchestrationByPaneKey), and an
  // identity check would then strand the clear-planted suppressor past Undo, losing the run.
  const introducedSuppressorLiveTurns = new Map(
    plan.retainedSnapshots.flatMap((retained) => {
      const paneKey = retained.entry.paneKey
      const liveEntry = state.agentStatusByPaneKey[paneKey]
      return liveEntry && !state.retentionSuppressedPaneKeys[paneKey]
        ? ([[paneKey, liveEntry.stateStartedAt]] as const)
        : []
    })
  )
  state.dismissRetainedAgents(plan.retainedSnapshots.map((retained) => retained.entry.paneKey))

  let undone = false
  let dropped = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const dropRetainedFromDiskCache = (): void => {
    pendingDiskEvictions.delete(dropRetainedFromDiskCache)
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
    if (undone || dropped) {
      return
    }
    dropped = true
    evictPersistedStatuses(plan.cacheIdentities)
  }
  pendingDiskEvictions.add(dropRetainedFromDiskCache)
  fallbackTimer = setTimeout(dropRetainedFromDiskCache, CLEAR_COMPLETED_EVICTION_FALLBACK_MS)
  toast(
    plan.clearedThreadCount === 1
      ? translate('auto.components.activity.clearCompleted.clearedOne', 'Cleared 1 completed agent')
      : translate(
          'auto.components.activity.clearCompleted.clearedMany',
          'Cleared {{count}} completed agents',
          { count: plan.clearedThreadCount }
        ),
    {
      action: {
        label: translate('auto.components.activity.clearCompleted.undo', 'Undo'),
        onClick: () => {
          undone = true
          pendingDiskEvictions.delete(dropRetainedFromDiskCache)
          if (fallbackTimer !== null) {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
          }
          const current = useAppStore.getState()
          const retainedByPaneKey = new Map(
            plan.retainedSnapshots.map((retained) => [retained.entry.paneKey, retained])
          )
          const restorePatch: Record<string, number | null> = {}
          const snapshotsToRestore: RetainedAgentEntry[] = []
          const suppressorPaneKeysToClear: string[] = []
          for (const paneKey of Object.keys(plan.restorePatch)) {
            const currentLive = current.agentStatusByPaneKey?.[paneKey]
            const currentRetained = current.retainedAgentsByPaneKey[paneKey]
            const clearedSnapshot = retainedByPaneKey.get(paneKey)
            const cutoffStillOwned =
              current.activityClearedAtByPaneKey[paneKey] === plan.cutoffPatch[paneKey]
            if (cutoffStillOwned) {
              restorePatch[paneKey] = plan.restorePatch[paneKey] ?? null
            }
            if (
              cutoffStillOwned &&
              introducedSuppressorLiveTurns.has(paneKey) &&
              currentLive?.stateStartedAt === introducedSuppressorLiveTurns.get(paneKey) &&
              current.retentionSuppressedPaneKeys[paneKey]
            ) {
              suppressorPaneKeysToClear.push(paneKey)
            }
            if (currentLive || (currentRetained && currentRetained !== clearedSnapshot)) {
              continue
            }
            if (clearedSnapshot && !currentRetained) {
              snapshotsToRestore.push(clearedSnapshot)
            }
          }
          current.applyActivityClearedAt(restorePatch)
          current.clearRetentionSuppressedPaneKeys(suppressorPaneKeysToClear)
          if (snapshotsToRestore.length > 0) {
            current.retainAgents(snapshotsToRestore)
          }
        }
      },
      onDismiss: dropRetainedFromDiskCache,
      onAutoClose: dropRetainedFromDiskCache
    }
  )
  return true
}
