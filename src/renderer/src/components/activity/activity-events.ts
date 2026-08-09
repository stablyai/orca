import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  getActivityThreadTaskTitle,
  resolveActivityThreadStatusPreview
} from '@/lib/activity-thread-display'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'

export type ActivityEventState = Extract<AgentStatusState, 'done' | 'blocked' | 'waiting'>
export type ActivityLiveAgentState = Extract<AgentStatusState, 'working' | 'blocked' | 'waiting'>

export type ActivityEvent = {
  id: string
  state: ActivityEventState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  migrationUnsupportedPtyId?: string
  unread: boolean
}

export type ActivityLiveAgentSnapshot = {
  state: ActivityLiveAgentState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
}

// Why: keyed per agent pane (tab + leaf id), not per workspace, so the list shows one row per agent; paneKey is `${tabId}:${leafId}`.
export type AgentPaneThread = {
  paneKey: string
  paneTitle: string
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  currentAgentState: ActivityLiveAgentState | null
  currentAgentEntry: AgentStatusEntry | null
  responsePreview: string
  latestTimestamp: number
  latestEvent: ActivityEvent | null
  events: ActivityEvent[]
  migrationUnsupportedPtyId?: string
  unread: boolean
}

const STANDALONE_ACTIVITY_WORKTREE_REPO_ID = '__activity_standalone__'

// Why: rows need a stable task identity across follow-up turns; the live turn prompt ("yes", "ok proceed") must not replace the task title.
export function paneTitleForEntry(
  entry: AgentStatusEntry,
  tab: TerminalTab,
  generatedTitlesEnabled: boolean
): string {
  return getActivityThreadTaskTitle({ entry, tab, generatedTitlesEnabled })
}

export function paneTitleForEvent(event: ActivityEvent, generatedTitlesEnabled: boolean): string {
  return paneTitleForEntry(event.entry, event.tab, generatedTitlesEnabled)
}

export function statusPreviewForEntry(
  entry: AgentStatusEntry,
  agentState?: AgentStatusState | null,
  previousPreview?: string
): string {
  return resolveActivityThreadStatusPreview(entry, agentState, previousPreview)
}

function isActivityEventState(state: AgentStatusState): state is ActivityEventState {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

function isActivityLiveAgentState(state: AgentStatusState): state is ActivityLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

export function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (!isActivityLiveAgentState(entry.state)) {
    return null
  }
  return isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) ? entry.state : null
}

export function standaloneActivityWorktree(worktreeId: string): Worktree {
  const displayName =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? 'Floating terminal' : 'Standalone terminal'
  return {
    id: worktreeId,
    repoId: STANDALONE_ACTIVITY_WORKTREE_REPO_ID,
    path: '',
    head: '',
    branch: displayName,
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

// Why: per-pane cap guarantees each agent appears in the left list even when one pane has a long history.
export const EVENTS_PER_PANE_CAP = 5

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

function appendActivityEvent(args: {
  events: ActivityEvent[]
  seenEventIds: Set<string>
  state: ActivityEventState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  acknowledgedAt: number
  migrationUnsupportedPtyId?: string
}): void {
  const id = `agent:${args.entry.paneKey}:${args.state}:${args.timestamp}`
  if (args.seenEventIds.has(id)) {
    return
  }
  args.seenEventIds.add(id)
  args.events.push({
    id,
    state: args.state,
    timestamp: args.timestamp,
    worktree: args.worktree,
    repo: args.repo,
    entry: args.entry,
    tab: args.tab,
    agentType: args.agentType,
    agentAlive: args.agentAlive,
    migrationUnsupportedPtyId: args.migrationUnsupportedPtyId,
    unread: args.acknowledgedAt < args.timestamp
  })
}

export function appendActivityEventsForEntry(args: {
  events: ActivityEvent[]
  seenEventIds: Set<string>
  entry: AgentStatusEntry
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  acknowledgedAt: number
  migrationUnsupportedPtyId?: string
}): void {
  // Why: Activity is append-only; when a pane continues (done→working), stateHistory is the only record of the previous done/blocking event.
  for (const history of args.entry.stateHistory) {
    if (!isActivityEventState(history.state)) {
      continue
    }
    appendActivityEvent({
      ...args,
      state: history.state,
      timestamp: history.startedAt,
      entry: historyEntrySnapshot(args.entry, history)
    })
  }

  // Why: SessionStart creates an idle row, not an "Agent finished" activity event (STA-3386).
  if (!isActivityEventState(args.entry.state) || args.entry.sessionBoundary === true) {
    return
  }
  appendActivityEvent({
    ...args,
    state: args.entry.state,
    timestamp: args.entry.stateStartedAt
  })
}
