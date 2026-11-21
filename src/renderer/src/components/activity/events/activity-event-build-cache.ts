import { entryWithRuntimeOrchestration } from '../../sidebar/workspace-card/activity/worktree-agent-row-orchestration'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  ActivityLiveAgentState
} from '../threads/activity-thread-types'
import { buildPaneActivityEvents } from './activity-pane-events'
import {
  buildActivityTabContext,
  buildActivityTabHostIndex,
  keepsActivityTabIdentities,
  patchActivityTabIndexes,
  type ActivityTabContext,
  type ActivityTabHostIndex,
  type TabBucketChange
} from './activity-event-builder-context'
import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { BuildActivityEventsArgs } from './activity-event-builder'
import { KeyedRebuildPlan } from '../../../../../shared/collections/keyed-rebuild-plan'

type ActivityTabInputs = Pick<
  BuildActivityEventsArgs,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'chatNames'
>

type ActivityTabIndexes = ActivityTabInputs & {
  context: Map<string, ActivityTabContext>
  hosts: ActivityTabHostIndex
}

type PaneActivityCacheEntry = {
  source: unknown
  orchestration: AgentStatusOrchestrationContext | undefined
  acknowledgedAt: number
  clearedAt: number
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  events: ActivityEvent[]
  live: ActivityLiveAgentSnapshot | null
  rowEntry: AgentStatusEntry
}

export type PaneBuild = {
  events: ActivityEvent[]
  live: ActivityLiveAgentSnapshot | null
  rowEntry: AgentStatusEntry
}

export type ActivityEventBuildCache = {
  panes: Map<string, PaneActivityCacheEntry>
  tabs?: ActivityTabIndexes
  /** Each accepted status's last outcome; null when it had no tab to attribute. */
  live: Map<string, { entry: AgentStatusEntry; build: PaneBuild | null }>
  plan: KeyedRebuildPlan
}

export function createActivityEventBuildCache(): ActivityEventBuildCache {
  return { panes: new Map(), live: new Map(), plan: new KeyedRebuildPlan() }
}

export function resetActivityEventBuildCache(cache: ActivityEventBuildCache): void {
  cache.panes.clear()
  cache.tabs = undefined
  cache.live.clear()
  cache.plan.reset()
}

/** The replaced buckets of an addressed write that kept the workspace set; null when it can't be read so. */
function replacedBuckets<T extends TerminalTab | Tab>(
  next: Record<string, T[]>,
  previous: Record<string, T[]>
): TabBucketChange<T>[] | null {
  const changes = readTabMapChanges(next, previous)
  if (!changes) {
    return []
  }
  if (changes.kind !== 'addressed' || changes.workspaceSetChanged) {
    return null
  }
  const buckets: TabBucketChange<T>[] = []
  for (const worktreeId of changes.workspaceIds) {
    const before = Object.hasOwn(previous, worktreeId) ? previous[worktreeId] : undefined
    const after = Object.hasOwn(next, worktreeId) ? next[worktreeId] : undefined
    if (!before || !after || !keepsActivityTabIdentities({ worktreeId, before, after })) {
      return null
    }
    buckets.push({ worktreeId, before, after })
  }
  return buckets
}

// A title or label write replaces buckets without moving any tab, so only those buckets re-index.
function patchedTabIndexes(
  args: ActivityTabInputs,
  previous: ActivityTabIndexes
): ActivityTabIndexes | null {
  if (
    previous.chatNames !== args.chatNames ||
    !previous.unifiedTabsByWorktree ||
    !args.unifiedTabsByWorktree
  ) {
    return null
  }
  const terminal = replacedBuckets(args.tabsByWorktree, previous.tabsByWorktree)
  const unified =
    terminal && replacedBuckets(args.unifiedTabsByWorktree, previous.unifiedTabsByWorktree)
  if (
    !terminal ||
    !unified ||
    // Only this cache holds the indexes, so patching them in place leaves no reader behind.
    !patchActivityTabIndexes(previous.context, previous.hosts, terminal, unified, args.chatNames)
  ) {
    return null
  }
  return {
    ...previous,
    tabsByWorktree: args.tabsByWorktree,
    unifiedTabsByWorktree: args.unifiedTabsByWorktree
  }
}

export function resolveActivityTabIndexes(
  args: ActivityTabInputs,
  cache: ActivityEventBuildCache | undefined
): ActivityTabIndexes {
  const previous = cache?.tabs
  if (
    previous &&
    previous.tabsByWorktree === args.tabsByWorktree &&
    previous.unifiedTabsByWorktree === args.unifiedTabsByWorktree &&
    previous.chatNames === args.chatNames
  ) {
    return previous
  }
  const next: ActivityTabIndexes = (previous && patchedTabIndexes(args, previous)) ?? {
    tabsByWorktree: args.tabsByWorktree,
    unifiedTabsByWorktree: args.unifiedTabsByWorktree,
    chatNames: args.chatNames,
    context: buildActivityTabContext(
      args.tabsByWorktree,
      args.unifiedTabsByWorktree,
      args.chatNames
    ),
    hosts:
      previous && previous.unifiedTabsByWorktree === args.unifiedTabsByWorktree
        ? previous.hosts
        : buildActivityTabHostIndex(args.unifiedTabsByWorktree)
  }
  if (cache) {
    cache.tabs = next
  }
  return next
}

export type PaneBuildRequest = {
  cacheKey: string
  source: unknown
  entry: AgentStatusEntry
  orchestration: AgentStatusOrchestrationContext | undefined
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  acknowledgedAt: number
  clearedAt: number
  migrationUnsupportedPtyId?: string
  liveState: ActivityLiveAgentState | null
}

export function resolvePaneBuild(
  request: PaneBuildRequest,
  cache: ActivityEventBuildCache | undefined,
  seenCacheKeys: Set<string> | null
): PaneBuild {
  seenCacheKeys?.add(request.cacheKey)
  const cached = cache?.panes.get(request.cacheKey)
  const inputsUnchanged =
    cached !== undefined &&
    cached.source === request.source &&
    cached.orchestration === request.orchestration &&
    cached.acknowledgedAt === request.acknowledgedAt &&
    cached.clearedAt === request.clearedAt &&
    cached.worktree === request.worktree &&
    cached.repo === request.repo &&
    cached.tab === request.tab
  const rowEntry = inputsUnchanged
    ? cached.rowEntry
    : entryWithRuntimeOrchestration(
        request.entry,
        request.orchestration ? { [request.entry.paneKey]: request.orchestration } : undefined
      )

  const liveTimestamp = rowEntry.stateStartedAt
  const liveMatchesCache =
    inputsUnchanged &&
    (request.liveState === null
      ? cached.live === null
      : cached.live !== null &&
        cached.live.state === request.liveState &&
        cached.live.timestamp === liveTimestamp)

  if (inputsUnchanged && liveMatchesCache) {
    return { events: cached.events, live: cached.live, rowEntry }
  }

  // The live turn is itself an event, so a live change always rebuilds the pane's events.
  const events = buildPaneActivityEvents({
    entry: rowEntry,
    worktree: request.worktree,
    repo: request.repo,
    tab: request.tab,
    agentType: request.agentType,
    agentAlive: request.agentAlive,
    acknowledgedAt: request.acknowledgedAt,
    clearedAt: request.clearedAt,
    liveState: request.liveState,
    migrationUnsupportedPtyId: request.migrationUnsupportedPtyId
  })
  const live: ActivityLiveAgentSnapshot | null =
    request.liveState === null
      ? null
      : {
          state: request.liveState,
          timestamp: liveTimestamp,
          worktree: request.worktree,
          repo: request.repo,
          entry: rowEntry,
          tab: request.tab,
          agentType: request.agentType,
          migrationUnsupportedPtyId: request.migrationUnsupportedPtyId
        }

  cache?.panes.set(request.cacheKey, {
    source: request.source,
    orchestration: request.orchestration,
    acknowledgedAt: request.acknowledgedAt,
    clearedAt: request.clearedAt,
    worktree: request.worktree,
    repo: request.repo,
    tab: request.tab,
    events,
    live,
    rowEntry
  })
  return { events, live, rowEntry }
}
