import type {
  AgentStateHistoryEntry,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityEvent, ActivityEventState } from './activity-thread-types'
import { EVENTS_PER_PANE_CAP } from './activity-event-cap'

export function isActivityEventState(
  state: AgentStatusEntry['state']
): state is ActivityEventState {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

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
    interrupted: history.interrupted
  }
}

/** Newest activity-eligible history entries, at most `cap`, oldest-first. */
export function newestActivityHistoryEntries(
  history: readonly AgentStateHistoryEntry[],
  cap: number
): AgentStateHistoryEntry[] {
  const newest: AgentStateHistoryEntry[] = []
  for (let i = history.length - 1; i >= 0 && newest.length < cap; i -= 1) {
    if (isActivityEventState(history[i].state)) {
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
  migrationUnsupportedPtyId?: string
}

/** Build one pane's activity events (bounded by the per-pane cap, cutoff applied). */
export function buildPaneActivityEvents(args: PaneEventInputs): ActivityEvent[] {
  const events: ActivityEvent[] = []
  const seenIds = new Set<string>()
  const append = (state: ActivityEventState, timestamp: number, entry: AgentStatusEntry): void => {
    const id = `agent:${entry.paneKey}:${state}:${timestamp}`
    if (seenIds.has(id)) {
      return
    }
    seenIds.add(id)
    events.push({
      id,
      state,
      timestamp,
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
      historyEntrySnapshot(args.entry, history)
    )
  }

  if (!isActivityEventState(args.entry.state) || args.entry.sessionBoundary === true) {
    return events
  }
  if (args.entry.stateStartedAt <= args.clearedAt) {
    return events
  }
  append(args.entry.state, args.entry.stateStartedAt, args.entry)
  return events
}
