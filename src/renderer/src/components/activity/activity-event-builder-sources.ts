import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityLiveAgentSnapshot, ActivityEvent } from './activity-thread-types'
import type { ActivityEventBuildCache } from './activity-event-build-cache'
import { resolvePaneBuild } from './activity-event-build-cache'
import type { BuildActivityEventsArgs } from './activity-event-builder'

export function appendUnsupportedAndRetainedEvents(context: {
  args: BuildActivityEventsArgs
  cache: ActivityEventBuildCache | undefined
  seenCacheKeys: Set<string> | null
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  tabContext: Map<string, { worktreeId: string; tab: TerminalTab }>
  resolveOwner: (
    context: { worktreeId: string; tab: TerminalTab },
    entry: AgentStatusEntry,
    terminalPtyId?: string | null
  ) => { worktree: Worktree; repo: Repo | null; knownWorktree: boolean }
  pushPaneEvents: (paneEvents: ActivityEvent[]) => void
}): void {
  const {
    args,
    cache,
    seenCacheKeys,
    liveAgentByPaneKey,
    tabContext,
    resolveOwner,
    pushPaneEvents
  } = context

  for (const unsupported of Object.values(args.migrationUnsupportedByPtyId ?? {})) {
    const cacheKey = `unsupported:${unsupported.paneKey ?? unsupported.ptyId}`
    const cached = cache?.panes.get(cacheKey)
    const entry =
      cached?.source === unsupported
        ? cached.rowEntry
        : migrationUnsupportedToAgentStatusEntry(unsupported)
    const parsed = entry ? parsePaneKey(entry.paneKey) : null
    const tabEntry = parsed ? tabContext.get(parsed.tabId) : null
    if (!entry || !tabEntry) {
      continue
    }
    const owner = resolveOwner(tabEntry, entry, unsupported.ptyId)
    const { events: paneEvents, live } = resolvePaneBuild(
      {
        cacheKey,
        source: unsupported,
        entry,
        orchestration: undefined,
        worktree: owner.worktree,
        repo: owner.repo,
        tab: tabEntry.tab,
        agentType: entry.agentType ?? 'unknown',
        agentAlive: false,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[entry.paneKey] ?? 0,
        migrationUnsupportedPtyId: unsupported.ptyId,
        liveState: 'blocked'
      },
      cache,
      seenCacheKeys
    )
    if (live) {
      liveAgentByPaneKey[entry.paneKey] = live
    }
    pushPaneEvents(paneEvents)
  }

  for (const [paneKey, retained] of Object.entries(args.retainedAgentsByPaneKey)) {
    if (!parsePaneKey(paneKey)) {
      continue
    }
    const owner = resolveOwner(
      { worktreeId: retained.worktreeId, tab: retained.tab },
      retained.entry,
      retained.tab.ptyId ?? retained.entry.terminalHandle
    )
    if (!owner.knownWorktree) {
      continue
    }
    const { events: paneEvents } = resolvePaneBuild(
      {
        cacheKey: `retained:${paneKey}`,
        source: retained,
        entry: retained.entry,
        orchestration: args.runtimeAgentOrchestrationByPaneKey?.[paneKey],
        worktree: owner.worktree,
        repo: owner.repo,
        tab: retained.tab,
        agentType: retained.agentType,
        agentAlive: false,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
        liveState: null
      },
      cache,
      seenCacheKeys
    )
    pushPaneEvents(paneEvents)
  }
}
