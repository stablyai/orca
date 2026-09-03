import { entryWithRuntimeOrchestration } from '../sidebar/worktree-agent-row-orchestration'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  ActivityLiveAgentState
} from './activity-thread-types'
import { buildPaneActivityEvents } from './activity-pane-events'

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

export type ActivityEventBuildCache = {
  panes: Map<string, PaneActivityCacheEntry>
}

export function createActivityEventBuildCache(): ActivityEventBuildCache {
  return { panes: new Map() }
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
): { events: ActivityEvent[]; live: ActivityLiveAgentSnapshot | null } {
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
    return { events: cached.events, live: cached.live }
  }

  const events = inputsUnchanged
    ? cached.events
    : buildPaneActivityEvents({
        entry: rowEntry,
        worktree: request.worktree,
        repo: request.repo,
        tab: request.tab,
        agentType: request.agentType,
        agentAlive: request.agentAlive,
        acknowledgedAt: request.acknowledgedAt,
        clearedAt: request.clearedAt,
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
          agentType: request.agentType
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
  return { events, live }
}
