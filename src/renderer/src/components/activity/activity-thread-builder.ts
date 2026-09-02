import {
  paneTitleForEntry,
  paneTitleForEvent,
  statusPreviewForEntry
} from './activity-thread-presentation'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  AgentPaneThread
} from './activity-thread-types'

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
        responsePreview: statusPreviewForEntry(liveAgent.entry, liveAgent.entry.state),
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
      liveAgent.entry.state,
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
