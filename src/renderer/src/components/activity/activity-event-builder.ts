import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'
import { activityLiveAgentState } from './activity-event-state'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { Repo } from '../../../../shared/repo-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityEvent, ActivityLiveAgentSnapshot } from './activity-thread-types'
import { capActivityEvents } from './activity-event-cap'
import './activity-pane-events'
import {
  resolveActivityTabIndexes,
  resolvePaneBuild,
  type ActivityEventBuildCache
} from './activity-event-build-cache'
import { appendUnsupportedEvents } from './activity-event-builder-sources'
import {
  attributedActivityTabContext,
  resolveActivityEventOwner,
  type ActivityEventOwner
} from './activity-event-builder-context'
import type { Translate } from '@/i18n/use-translate'

export type BuildActivityEventsArgs = {
  chatNames: StructuredChatTabNames
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId?: Record<string, string[]>
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
  cache?: ActivityEventBuildCache,
  t?: Translate
): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  paneEntryByPaneKey: Record<string, AgentStatusEntry>
} {
  const events: ActivityEvent[] = []
  const paneEntryByPaneKey: Record<string, AgentStatusEntry> = {}
  const seenEventIds = new Set<string>()
  const { context: tabContext, hosts: tabHostIndex } = resolveActivityTabIndexes(args, cache)
  const ownerCache = new Map<string, ActivityEventOwner>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}
  const seenCacheKeys = cache ? new Set<string>() : null

  const pushPaneEvents = (paneEvents: ActivityEvent[], rowEntry: AgentStatusEntry): void => {
    // Preserve globally unique event IDs with first-source precedence.
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
    const parsed = parseAgentStatusPaneIdentity(
      paneKey,
      args.unifiedTabsByWorktree
        ? getStructuredAgentSessionTabsByPaneKey(args.unifiedTabsByWorktree).get(paneKey)
        : undefined
    )
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
      ownerCache,
      t
    )
    const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
    // Only fresh raw live state proves working; history and orchestration enrichment cannot establish liveness.
    const liveState = activityLiveAgentState(
      entry,
      args.now,
      tabHasLivePty(args.ptyIdsByTabId ?? {}, context.tab.id)
    )
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

  appendUnsupportedEvents({
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
