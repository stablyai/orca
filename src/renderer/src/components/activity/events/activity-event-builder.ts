import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  getStructuredAgentSessionTabsByPaneKey,
  structuredTabsByPaneKey,
  type StructuredTab
} from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parseAgentStatusPaneIdentity } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { tabHasLivePty } from '../../../../../shared/workspace-layout/terminal-surfaces/tab-has-live-pty'
import { activityLiveAgentState } from './activity-event-state'
import { agentRowStateDecaysAfter } from '../../../../../shared/agent-status/presentation/agent-row-decay-state'
import { standaloneActivityWorktreeScope } from './activity-standalone-worktree'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ActivityEvent, ActivityLiveAgentSnapshot } from '../threads/activity-thread-types'
import { capActivityEvents } from './activity-event-cap'
import './activity-pane-events'
import {
  resolveActivityTabIndexes,
  resolvePaneBuild,
  type ActivityEventBuildCache,
  type PaneBuild
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
  agentStatusByPaneKey: AcceptedAgentStatuses
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId?: Record<string, string[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  /** Chats from the store's own tab map; reading them from a projected map rebuilds the shared list. */
  structuredTabs?: readonly StructuredTab[]
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  resolveWorktree?: (worktreeId: string, executionHostId?: ExecutionHostId) => Worktree | undefined
  /** Every value resolveWorktree reads; without them a cached build cannot reuse any pane. */
  resolveWorktreeInputs?: readonly unknown[]
  acknowledgedAgentsByPaneKey: Record<string, number>
  /** Per-pane "Clear completed" cutoffs; events stamped at or before the cutoff are hidden. */
  activityClearedAtByPaneKey?: Record<string, number>
  now: number
}

/** Everything a pane build reads besides its own status entry and the clock. */
function paneBuildInputs(args: BuildActivityEventsArgs, t: Translate | undefined): unknown[] {
  return [
    args.chatNames,
    args.runtimeAgentOrchestrationByPaneKey,
    args.migrationUnsupportedByPtyId,
    args.tabsByWorktree,
    args.ptyIdsByTabId,
    args.unifiedTabsByWorktree,
    args.structuredTabs,
    args.worktreeMap,
    args.repoMap,
    args.repos,
    args.resolveWorktree,
    args.acknowledgedAgentsByPaneKey,
    args.activityClearedAtByPaneKey,
    t,
    standaloneActivityWorktreeScope(),
    // A fresh object never matches, so an untracked resolver always rebuilds.
    ...(args.resolveWorktree ? (args.resolveWorktreeInputs ?? [{}]) : [])
  ]
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
  const statuses = args.agentStatusByPaneKey
  const rebuild = cache?.plan.begin(statuses.projection, paneBuildInputs(args, t), args.now)
  // Only journaled panes and panes whose freshness lapsed can change while other inputs hold.
  const dirty = rebuild?.dirty ?? null
  const events: ActivityEvent[] = []
  const paneEntryByPaneKey: Record<string, AgentStatusEntry> = {}
  let seenEventIds: Set<string> | null = null
  const { context: tabContext, hosts: tabHostIndex } = resolveActivityTabIndexes(args, cache)
  const ownerCache = new Map<string, ActivityEventOwner>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}
  const seenCacheKeys = cache && !dirty ? new Set<string>() : null
  if (cache && !dirty) {
    cache.live.clear()
  }

  const pushPaneEvents = (paneEvents: ActivityEvent[], rowEntry: AgentStatusEntry): void => {
    // Preserve globally unique event IDs with first-source precedence. IDs embed the pane key,
    // so only a second source for an already listed pane can repeat one.
    if (paneEntryByPaneKey[rowEntry.paneKey] === undefined) {
      paneEntryByPaneKey[rowEntry.paneKey] = rowEntry
    } else {
      seenEventIds ??= new Set(events.map((event) => event.id))
    }
    for (const event of paneEvents) {
      if (seenEventIds) {
        if (seenEventIds.has(event.id)) {
          continue
        }
        seenEventIds.add(event.id)
      }
      events.push(event)
    }
  }

  const buildLivePane = (paneKey: string, entry: AgentStatusEntry): PaneBuild | null => {
    const parsed = parseAgentStatusPaneIdentity(
      paneKey,
      (args.structuredTabs
        ? structuredTabsByPaneKey(args.structuredTabs)
        : getStructuredAgentSessionTabsByPaneKey(args.unifiedTabsByWorktree)
      ).get(paneKey)
    )
    if (!parsed) {
      return null
    }
    // A tabless pane is listed only where workspace cards list it: finished local panes whose tab closed drop out.
    const context =
      tabContext.get(parsed.tabId) ??
      (statuses.projection.rowWorktree(paneKey) ? attributedActivityTabContext(entry) : null)
    if (!context) {
      return null
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
    return resolvePaneBuild(
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
  }

  for (const [paneKey, entry] of statuses.entries()) {
    let slot = dirty && !dirty.has(paneKey) ? cache?.live.get(paneKey) : undefined
    if (slot?.entry !== entry) {
      slot = { entry, build: buildLivePane(paneKey, entry) }
      if (cache) {
        cache.live.set(paneKey, slot)
        const decaysAfter = slot.build ? agentRowStateDecaysAfter(entry) : undefined
        // Already-stale rows stay stale while the clock moves forward.
        cache.plan.deadlines.set(
          paneKey,
          decaysAfter !== undefined && decaysAfter >= args.now ? decaysAfter : undefined
        )
        if (!slot.build) {
          cache.panes.delete(`live:${paneKey}`)
        }
      }
    }
    if (!slot.build) {
      continue
    }
    if (slot.build.live) {
      liveAgentByPaneKey[paneKey] = slot.build.live
    }
    pushPaneEvents(slot.build.events, slot.build.rowEntry)
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

  if (cache && dirty) {
    // Removed panes are journaled; the size check sweeps any the journal did not name.
    const forget = (key: string): void => {
      if (!statuses.has(key) && cache.live.delete(key)) {
        cache.panes.delete(`live:${key}`)
        cache.plan.deadlines.delete(key)
      }
    }
    dirty.forEach(forget)
    if (cache.live.size !== statuses.size) {
      Array.from(cache.live.keys()).forEach(forget)
    }
  }
  // Evict panes absent from every source so caches cannot outgrow live maps.
  if (cache && seenCacheKeys) {
    for (const cacheKey of cache.panes.keys()) {
      if (!seenCacheKeys.has(cacheKey)) {
        cache.panes.delete(cacheKey)
      }
    }
  }
  const result = { events: capActivityEvents(events), liveAgentByPaneKey, paneEntryByPaneKey }
  if (cache && rebuild) {
    cache.plan.complete(rebuild)
  }
  return result
}
