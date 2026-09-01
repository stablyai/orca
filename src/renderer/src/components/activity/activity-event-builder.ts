import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityEventState,
  ActivityHookLiveAgentState,
  ActivityLiveAgentSnapshot,
  ActivityLiveAgentState
} from './activity-thread-types'
import { capActivityEvents } from './activity-event-cap'

const STANDALONE_ACTIVITY_WORKTREE_REPO_ID = '__activity_standalone__'

function isActivityEventState(state: AgentStatusState): state is ActivityEventState {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

function isActivityHookLiveAgentState(
  state: AgentStatusState
): state is ActivityHookLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (
    !isActivityHookLiveAgentState(entry.state) ||
    !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
  ) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring'
    ? 'monitoring'
    : entry.state
}

function standaloneActivityWorktree(worktreeId: string): Worktree {
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

function appendActivityEventsForEntry(args: {
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

type BuildActivityEventsArgs = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  acknowledgedAgentsByPaneKey: Record<string, number>
  now: number
}

export function buildActivityEvents(args: BuildActivityEventsArgs): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
} {
  const events: ActivityEvent[] = []
  const seenEventIds = new Set<string>()
  const tabContext = new Map<string, { worktree: Worktree; tab: TerminalTab }>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}

  for (const [worktreeId, tabs] of Object.entries(args.tabsByWorktree)) {
    const worktree = args.worktreeMap.get(worktreeId) ?? standaloneActivityWorktree(worktreeId)
    for (const tab of tabs) {
      tabContext.set(tab.id, { worktree, tab })
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const context = tabContext.get(parsed.tabId)
    if (!context) {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    // Why: live status is separate from history; a fresh working turn updates the thread without counting as an unread done/blocked/waiting event.
    const liveState = freshActivityLiveAgentState(entry, args.now)
    if (liveState) {
      liveAgentByPaneKey[paneKey] = {
        state: liveState,
        timestamp: entry.stateStartedAt,
        worktree: context.worktree,
        repo: args.repoMap.get(context.worktree.repoId) ?? null,
        entry,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown'
      }
    }
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown',
      agentAlive: true,
      acknowledgedAt: ackAt
    })
  }

  appendUnsupportedAndRetainedEvents(args, events, seenEventIds, liveAgentByPaneKey, tabContext)
  return { events: capActivityEvents(events), liveAgentByPaneKey }
}

function appendUnsupportedAndRetainedEvents(
  args: BuildActivityEventsArgs,
  events: ActivityEvent[],
  seenEventIds: Set<string>,
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>,
  tabContext: Map<string, { worktree: Worktree; tab: TerminalTab }>
): void {
  for (const unsupported of Object.values(args.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    const parsed = entry ? parsePaneKey(entry.paneKey) : null
    const context = parsed ? tabContext.get(parsed.tabId) : null
    if (!entry || !context) {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0
    liveAgentByPaneKey[entry.paneKey] = {
      state: 'blocked',
      timestamp: entry.stateStartedAt,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown'
    }
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown',
      agentAlive: false,
      acknowledgedAt: ackAt,
      migrationUnsupportedPtyId: unsupported.ptyId
    })
  }

  for (const [paneKey, retained] of Object.entries(args.retainedAgentsByPaneKey)) {
    if (!parsePaneKey(paneKey)) {
      continue
    }
    const worktree =
      args.worktreeMap.get(retained.worktreeId) ??
      (args.tabsByWorktree[retained.worktreeId]
        ? standaloneActivityWorktree(retained.worktreeId)
        : null)
    if (!worktree) {
      continue
    }
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree,
      repo: args.repoMap.get(worktree.repoId) ?? null,
      entry: retained.entry,
      tab: retained.tab,
      agentType: retained.agentType,
      agentAlive: false,
      acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    })
  }
}
