import { migrationUnsupportedToAgentStatusEntry } from '../../../../shared/migration-unsupported-agent-entry'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityLiveAgentSnapshot, ActivityEvent } from './activity-thread-types'

import { type ActivityEventBuildCache, resolvePaneBuild } from './activity-event-build-cache'
import type { BuildActivityEventsArgs } from './activity-event-builder'

export function appendUnsupportedEvents(context: {
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
  pushPaneEvents: (paneEvents: ActivityEvent[], rowEntry: AgentStatusEntry) => void
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
    const {
      events: paneEvents,
      live,
      rowEntry
    } = resolvePaneBuild(
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
    pushPaneEvents(paneEvents, rowEntry)
  }
}
