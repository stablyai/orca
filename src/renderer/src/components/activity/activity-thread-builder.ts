import {
  paneTitleForEntry,
  paneTitleForEvent,
  statusPreviewForEntry
} from './activity-thread-presentation'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveAgentRowPaneLiveTitle } from '../dashboard/agent-row-pane-live-title'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  AgentPaneThread
} from './activity-thread-types'

/**
 * Caller-owned reuse cache: threads whose derived content is unchanged keep their
 * previous object (and the whole list keeps its array) identity, so memo'd rows and
 * the search-text cache survive unrelated store writes.
 */
export type AgentPaneThreadReuseCache = {
  previousByPaneKey: Map<string, AgentPaneThread>
  previousList: AgentPaneThread[]
}

export function createAgentPaneThreadReuseCache(): AgentPaneThreadReuseCache {
  return { previousByPaneKey: new Map(), previousList: [] }
}

function arrayItemsEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

// Why: event and live-snapshot identities are preserved upstream (activity-event-builder
// cache), so identity comparison on the referenced objects is a correct change detector.
function reuseThreadIfEqual(
  previous: AgentPaneThread | undefined,
  next: AgentPaneThread
): AgentPaneThread {
  if (
    previous !== undefined &&
    previous.paneKey === next.paneKey &&
    previous.paneTitle === next.paneTitle &&
    previous.worktree === next.worktree &&
    previous.repo === next.repo &&
    previous.tab === next.tab &&
    previous.agentType === next.agentType &&
    previous.currentAgentState === next.currentAgentState &&
    previous.currentAgentEntry === next.currentAgentEntry &&
    previous.paneEntry === next.paneEntry &&
    previous.responsePreview === next.responsePreview &&
    previous.latestTimestamp === next.latestTimestamp &&
    previous.latestEvent === next.latestEvent &&
    previous.migrationUnsupportedPtyId === next.migrationUnsupportedPtyId &&
    previous.unread === next.unread &&
    arrayItemsEqual(previous.events, next.events)
  ) {
    return previous
  }
  return next
}

export function buildAgentPaneThreads(
  args: {
    events: ActivityEvent[]
    liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
    paneEntryByPaneKey?: Record<string, AgentStatusEntry>
    generatedTitlesEnabled?: boolean
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
    runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  },
  reuseCache?: AgentPaneThreadReuseCache
): AgentPaneThread[] {
  const generatedTitlesEnabled = args.generatedTitlesEnabled === true
  // Why: in a split tab, tab.title belongs to the focused pane, so each row reads its own pane's title.
  const paneLiveTitleFor = (paneKey: string, tabId: string): string | null | undefined =>
    resolveAgentRowPaneLiveTitle(
      args.terminalLayoutsByTabId?.[tabId],
      args.runtimePaneTitlesByTabId?.[tabId],
      parsePaneKey(paneKey)?.leafId
    )
  const byPaneKey = new Map<string, AgentPaneThread>()
  for (const event of args.events) {
    const paneKey = event.entry.paneKey
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEvent(
          event,
          generatedTitlesEnabled,
          paneLiveTitleFor(paneKey, event.tab.id)
        ),
        worktree: event.worktree,
        repo: event.repo,
        tab: event.tab,
        agentType: event.agentType,
        currentAgentState: null,
        currentAgentEntry: null,
        paneEntry: args.paneEntryByPaneKey?.[paneKey],
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
    // Why max, not the latest event's: "Clear completed" cuts off at this, and must pass every event.
    existing.latestTimestamp = Math.max(existing.latestTimestamp, event.timestamp)
    if (!existing.latestEvent || event.observedAt > existing.latestEvent.observedAt) {
      existing.latestEvent = event
      existing.paneTitle = paneTitleForEvent(
        event,
        generatedTitlesEnabled,
        paneLiveTitleFor(paneKey, event.tab.id)
      )
      existing.agentType = event.agentType
      existing.tab = event.tab
      existing.responsePreview = statusPreviewForEntry(
        event.entry,
        event.state,
        existing.responsePreview
      )
    }
  }

  for (const [paneKey, liveAgent] of Object.entries(args.liveAgentByPaneKey)) {
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEntry(
          liveAgent.entry,
          liveAgent.tab,
          generatedTitlesEnabled,
          paneLiveTitleFor(paneKey, liveAgent.tab.id)
        ),
        worktree: liveAgent.worktree,
        repo: liveAgent.repo,
        tab: liveAgent.tab,
        agentType: liveAgent.agentType,
        currentAgentState: liveAgent.state,
        currentAgentEntry: liveAgent.entry,
        paneEntry: args.paneEntryByPaneKey?.[paneKey],
        responsePreview: statusPreviewForEntry(liveAgent.entry, liveAgent.entry.state),
        latestTimestamp: liveAgent.timestamp,
        latestEvent: null,
        events: [],
        unread: false
      })
      continue
    }
    // Why: row title/time/target must follow the active turn (not historical events) so a running agent never shows the previous prompt as primary.
    existing.paneTitle = paneTitleForEntry(
      liveAgent.entry,
      liveAgent.tab,
      generatedTitlesEnabled,
      paneLiveTitleFor(paneKey, liveAgent.tab.id)
    )
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

  const built = Array.from(byPaneKey.values())
    .map((thread) => {
      const next: AgentPaneThread = {
        ...thread,
        events: [...thread.events].sort((a, b) => b.observedAt - a.observedAt)
      }
      return reuseThreadIfEqual(reuseCache?.previousByPaneKey.get(thread.paneKey), next)
    })
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp)

  if (!reuseCache) {
    return built
  }
  // Why: keep the list's array identity too, so downstream memos keyed on the list bail out.
  const result = arrayItemsEqual(reuseCache.previousList, built) ? reuseCache.previousList : built
  reuseCache.previousList = result
  reuseCache.previousByPaneKey = new Map(result.map((thread) => [thread.paneKey, thread]))
  return result
}
