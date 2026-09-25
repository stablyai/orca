import { isHistoricalActivityState } from './activity-event-state'
import type {
  AgentStateHistoryEntry,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityEventState,
  ActivityLiveAgentState
} from './activity-thread-types'
import { EVENTS_PER_PANE_CAP } from './activity-event-cap'

function historyEntrySnapshot(
  entry: AgentStatusEntry,
  history: AgentStateHistoryEntry
): AgentStatusEntry {
  return {
    ...entry,
    state: history.state,
    prompt: history.prompt,
    updatedAt: history.startedAt,
    stateStartedAt: history.startedAt,
    stateHistory: [],
    toolName: undefined,
    toolInput: undefined,
    lastAssistantMessage: undefined,
    interrupted: history.interrupted,
    // The live row's main agent belongs to its current state; this snapshot keeps only its own verdict.
    mainAgent: history.outcome
      ? { state: history.state, outcome: history.outcome, stateStartedAt: history.startedAt }
      : undefined
  }
}

/** Newest activity-eligible history entries, at most `cap`, oldest-first. */
export function newestActivityHistoryEntries(
  history: readonly AgentStateHistoryEntry[],
  cap: number
): AgentStateHistoryEntry[] {
  const newest: AgentStateHistoryEntry[] = []
  for (let i = history.length - 1; i >= 0 && newest.length < cap; i -= 1) {
    if (isHistoricalActivityState(history[i].state)) {
      newest.push(history[i])
    }
  }
  return newest.toReversed()
}

type PaneEventInputs = {
  entry: AgentStatusEntry
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentStatusEntry['agentType']
  agentAlive: boolean
  acknowledgedAt: number
  clearedAt: number
  liveState: ActivityLiveAgentState | null
  migrationUnsupportedPtyId?: string
}

/** Build one pane's activity events (bounded by the per-pane cap, cutoff applied). */
export function buildPaneActivityEvents(args: PaneEventInputs): ActivityEvent[] {
  const events: ActivityEvent[] = []
  const seenIds = new Set<string>()
  const append = (
    state: ActivityEventState,
    timestamp: number,
    observedAt: number,
    entry: AgentStatusEntry
  ): void => {
    // Why observedAt: an answered ask returns done to its turn's end, repeating that done's time.
    const id = `agent:${entry.paneKey}:${state}:${observedAt}`
    if (seenIds.has(id)) {
      return
    }
    seenIds.add(id)
    events.push({
      id,
      state,
      timestamp,
      observedAt,
      worktree: args.worktree,
      repo: args.repo,
      entry,
      tab: args.tab,
      agentType: args.agentType ?? 'unknown',
      agentAlive: args.agentAlive,
      migrationUnsupportedPtyId: args.migrationUnsupportedPtyId,
      unread: args.acknowledgedAt < timestamp
    })
  }

  for (const history of newestActivityHistoryEntries(
    args.entry.stateHistory,
    EVENTS_PER_PANE_CAP
  )) {
    if (history.startedAt <= args.clearedAt) {
      continue
    }
    append(
      history.state as ActivityEventState,
      history.startedAt,
      history.observedAt ?? history.startedAt,
      historyEntrySnapshot(args.entry, history)
    )
  }

  // Monitoring live turns surface only via the 'monitoring' snapshot, never as a working event.
  const currentState =
    args.liveState === 'working' || isHistoricalActivityState(args.entry.state)
      ? args.entry.state
      : null
  if (currentState === null || args.entry.sessionBoundary === true) {
    return events
  }
  if (args.entry.stateStartedAt <= args.clearedAt) {
    return events
  }
  append(
    currentState,
    args.entry.stateStartedAt,
    args.entry.stateObservedAt ?? args.entry.stateStartedAt,
    args.entry
  )
  return events
}
