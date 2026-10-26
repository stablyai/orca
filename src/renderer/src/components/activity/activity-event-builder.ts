import { freshActivityLiveAgentState } from './activity-event-state'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StructuredChatTabNames } from '@/runtime/structured-chat-tab-name'
import type { Repo } from '../../../../shared/repo-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityEvent, ActivityLiveAgentSnapshot } from './activity-thread-types'
import { capActivityEvents } from './activity-event-cap'
import { newestActivityHistoryEntries } from './activity-pane-events'
import {
  createActivityEventBuildCache,
  resolvePaneBuild,
  type ActivityEventBuildCache
} from './activity-event-build-cache'
import { appendUnsupportedAndRetainedEvents } from './activity-event-builder-sources'
import {
  attributedActivityTabContext,
  buildActivityTabContext,
  buildActivityTabHostIndex,
  resolveActivityEventOwner,
  type ActivityEventOwner
} from './activity-event-builder-context'

export { createActivityEventBuildCache, type ActivityEventBuildCache, newestActivityHistoryEntries }

export type BuildActivityEventsArgs = {
  chatNames: StructuredChatTabNames
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  resolveWorktree?: (worktreeId: string, executionHostId?: ExecutionHostId) => Worktree | undefined
  acknowledgedAgentsByPaneKey: Record<string, number>
  /** Per-pane "Clear completed" cutoffs; events stamped at or before the cutoff are hidden. */
  activityClearedAtByPaneKey?: Record<string, number>
  now: number
}

export function buildActivityEvents(
  args: BuildActivityEventsArgs,
  cache?: ActivityEventBuildCache
): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  paneEntryByPaneKey: Record<string, AgentStatusEntry>
} {
  const events: ActivityEvent[] = []
  const paneEntryByPaneKey: Record<string, AgentStatusEntry> = {}
  const seenEventIds = new Set<string>()
  const tabContext = buildActivityTabContext(
    args.tabsByWorktree,
    args.unifiedTabsByWorktree,
    args.chatNames
  )
  const tabHostIndex = buildActivityTabHostIndex(args.unifiedTabsByWorktree)
  const ownerCache = new Map<string, ActivityEventOwner>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}
  const seenCacheKeys = cache ? new Set<string>() : null

  const pushPaneEvents = (paneEvents: ActivityEvent[], rowEntry: AgentStatusEntry): void => {
    // Live/retained sources can overlap; keep globally unique event IDs with first-source precedence.
    paneEntryByPaneKey[rowEntry.paneKey] ??= rowEntry
    for (const event of paneEvents) {
      if (seenEventIds.has(event.id)) {
        continue
      }
      seenEventIds.add(event.id)
      events.push(event)
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const context = tabContext.get(parsed.tabId) ?? attributedActivityTabContext(entry)
    if (!context) {
      continue
    }
    const owner = resolveActivityEventOwner(
      args,
      context,
      entry,
      context.tab.ptyId,
      tabHostIndex,
      ownerCache
    )
    const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
    // Only fresh raw live state proves working; history and orchestration enrichment cannot establish liveness.
    const liveState = freshActivityLiveAgentState(entry, args.now)
    const {
      events: paneEvents,
      live,
      rowEntry
    } = resolvePaneBuild(
      {
        cacheKey: `live:${paneKey}`,
        source: entry,
        entry,
        orchestration,
        worktree: owner.worktree,
        repo: owner.repo,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown',
        agentAlive: true,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
        liveState
      },
      cache,
      seenCacheKeys
    )
    if (live) {
      liveAgentByPaneKey[paneKey] = live
    }
    pushPaneEvents(paneEvents, rowEntry)
  }

  appendUnsupportedAndRetainedEvents({
    args,
    cache,
    seenCacheKeys,
    liveAgentByPaneKey,
    tabContext,
    resolveOwner: (context, entry, terminalPtyId) =>
      resolveActivityEventOwner(args, context, entry, terminalPtyId, tabHostIndex, ownerCache),
    pushPaneEvents
  })

  // Evict panes absent from every source so caches cannot outgrow live maps.
  if (cache && seenCacheKeys) {
    for (const cacheKey of cache.panes.keys()) {
      if (!seenCacheKeys.has(cacheKey)) {
        cache.panes.delete(cacheKey)
      }
    }
  }
  return { events: capActivityEvents(events), liveAgentByPaneKey, paneEntryByPaneKey }
}
