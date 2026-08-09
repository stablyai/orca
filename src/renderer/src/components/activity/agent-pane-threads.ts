import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  EVENTS_PER_PANE_CAP,
  appendActivityEventsForEntry,
  freshActivityLiveAgentState,
  paneTitleForEntry,
  paneTitleForEvent,
  standaloneActivityWorktree,
  statusPreviewForEntry,
  type ActivityEvent,
  type ActivityLiveAgentSnapshot,
  type AgentPaneThread
} from './activity-events'

export function buildActivityEvents(args: {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  acknowledgedAgentsByPaneKey: Record<string, number>
  now: number
}): {
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

  for (const unsupported of Object.values(args.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (!entry) {
      continue
    }
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed) {
      continue
    }
    const context = tabContext.get(parsed.tabId)
    if (!context) {
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
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree,
      repo: args.repoMap.get(worktree.repoId) ?? null,
      entry: retained.entry,
      tab: retained.tab,
      agentType: retained.agentType,
      agentAlive: false,
      acknowledgedAt: ackAt
    })
  }

  const sorted = events.sort((a, b) => b.timestamp - a.timestamp)
  const perPaneCount = new Map<string, number>()
  const includedEventIds = new Set<string>()
  const capped: ActivityEvent[] = []
  // Why: reserve each pane's newest event before the global 80-event cap so the validator's >16 panes × ≥5 events can't push a pane out of the window and hide it.
  for (const event of sorted) {
    const paneKey = event.entry.paneKey
    if (perPaneCount.has(paneKey)) {
      continue
    }
    if (capped.length >= 80) {
      break
    }
    perPaneCount.set(paneKey, 1)
    includedEventIds.add(event.id)
    capped.push(event)
  }
  for (const event of sorted) {
    if (includedEventIds.has(event.id)) {
      continue
    }
    if (capped.length >= 80) {
      break
    }
    const paneKey = event.entry.paneKey
    const count = perPaneCount.get(paneKey) ?? 0
    if (count >= EVENTS_PER_PANE_CAP) {
      continue
    }
    perPaneCount.set(paneKey, count + 1)
    includedEventIds.add(event.id)
    capped.push(event)
  }
  return { events: capped.sort((a, b) => b.timestamp - a.timestamp), liveAgentByPaneKey }
}

export function buildAgentPaneThreads(args: {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  generatedTitlesEnabled?: boolean
}): AgentPaneThread[] {
  const generatedTitlesEnabled = args.generatedTitlesEnabled === true
  const byPaneKey = new Map<string, AgentPaneThread>()
  for (const event of args.events) {
    const paneKey = event.entry.paneKey
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEvent(event, generatedTitlesEnabled),
        worktree: event.worktree,
        repo: event.repo,
        tab: event.tab,
        agentType: event.agentType,
        currentAgentState: null,
        currentAgentEntry: null,
        responsePreview: statusPreviewForEntry(event.entry, event.state),
        latestTimestamp: event.timestamp,
        latestEvent: event,
        events: [event],
        migrationUnsupportedPtyId: event.migrationUnsupportedPtyId,
        unread: event.unread
      })
      continue
    }
    existing.events.push(event)
    existing.unread = existing.unread || event.unread
    existing.migrationUnsupportedPtyId =
      existing.migrationUnsupportedPtyId ?? event.migrationUnsupportedPtyId
    if (!existing.latestEvent || event.timestamp > existing.latestEvent.timestamp) {
      existing.latestEvent = event
      existing.paneTitle = paneTitleForEvent(event, generatedTitlesEnabled)
      existing.agentType = event.agentType
      existing.tab = event.tab
      existing.responsePreview = statusPreviewForEntry(
        event.entry,
        event.state,
        existing.responsePreview
      )
      existing.latestTimestamp = event.timestamp
    }
  }

  for (const [paneKey, liveAgent] of Object.entries(args.liveAgentByPaneKey)) {
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEntry(liveAgent.entry, liveAgent.tab, generatedTitlesEnabled),
        worktree: liveAgent.worktree,
        repo: liveAgent.repo,
        tab: liveAgent.tab,
        agentType: liveAgent.agentType,
        currentAgentState: liveAgent.state,
        currentAgentEntry: liveAgent.entry,
        responsePreview: statusPreviewForEntry(liveAgent.entry, liveAgent.state),
        latestTimestamp: liveAgent.timestamp,
        latestEvent: null,
        events: [],
        unread: false
      })
      continue
    }
    // Why: row title/time/target must follow the active turn (not historical events) so a running agent never shows the previous prompt as primary.
    existing.paneTitle = paneTitleForEntry(liveAgent.entry, liveAgent.tab, generatedTitlesEnabled)
    existing.worktree = liveAgent.worktree
    existing.repo = liveAgent.repo
    existing.tab = liveAgent.tab
    existing.agentType = liveAgent.agentType
    existing.currentAgentState = liveAgent.state
    existing.currentAgentEntry = liveAgent.entry
    existing.responsePreview = statusPreviewForEntry(
      liveAgent.entry,
      liveAgent.state,
      existing.responsePreview
    )
    existing.latestTimestamp = liveAgent.timestamp
  }

  return Array.from(byPaneKey.values())
    .map((thread) => ({
      ...thread,
      events: [...thread.events].sort((a, b) => b.timestamp - a.timestamp)
    }))
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
}

// Why: badges must equal the unread rows the Agents page renders (and that "Mark all read" acks) — derive both from the same thread build.
export function countUnreadAgentPaneThreads(
  args: Parameters<typeof buildActivityEvents>[0]
): number {
  const { events, liveAgentByPaneKey } = buildActivityEvents(args)
  let count = 0
  for (const thread of buildAgentPaneThreads({ events, liveAgentByPaneKey })) {
    if (thread.unread) {
      count += 1
    }
  }
  return count
}
