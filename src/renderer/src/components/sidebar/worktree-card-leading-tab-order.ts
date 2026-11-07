import type { AppState } from '@/store/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isAgentStatusFresh } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  IDLE,
  buildExplicitEntriesByTabId,
  collectTabPaneInputs,
  resolveAttention,
  type TabPaneInputSources,
  type WorktreeAttention
} from '../../../../shared/sidebar-list/smart-attention'

let cachedEntriesInputs: [unknown, unknown] | null = null
let cachedEntriesByTabId: ReadonlyMap<string, AgentStatusEntry[]> = new Map()

// Every card reads the same index; rebuild only when the status maps change.
function entriesByTabId(state: AppState): ReadonlyMap<string, AgentStatusEntry[]> {
  const statuses = state.agentStatusByPaneKey
  const unsupported = state.migrationUnsupportedByPtyId
  if (cachedEntriesInputs?.[0] !== statuses || cachedEntriesInputs[1] !== unsupported) {
    cachedEntriesByTabId = buildExplicitEntriesByTabId(statuses, unsupported)
    cachedEntriesInputs = [statuses, unsupported]
  }
  return cachedEntriesByTabId
}

/** Newest human focus or agent state change; tool pings move `updatedAt`, not `stateStartedAt`. */
function latestEventAt(tab: Tab, entries: readonly AgentStatusEntry[], now: number): number {
  let at = tab.lastFocusedAt ?? 0
  for (const entry of entries) {
    if (Number.isFinite(entry.stateStartedAt) && isAgentStatusFresh(entry, now)) {
      at = Math.max(at, entry.stateStartedAt)
    }
  }
  return at
}

type RankedTab = { tab: Tab; latestAt: number; attention: WorktreeAttention }

/**
 * The worktree's tabs ordered by the sidebar's own sort: Smart ranks each tab the way it ranks
 * the row (needs you > recent Done > Working > idle), so the front tile is the tab that placed
 * the row. Every other mode, including Recent, puts the newest focus or agent state change first.
 */
export function orderWorktreeLeadingTabs(state: AppState, worktreeId: string): Tab[] {
  const tabs = state.unifiedTabsByWorktree[worktreeId]
  if (!tabs || tabs.length === 0) {
    return []
  }
  const now = Date.now()
  const byTabId = entriesByTabId(state)
  const smart = state.sortBy === 'smart'
  const terminalTabs = state.tabsByWorktree[worktreeId]
  const worktreeLastActivityAt = smart
    ? (findWorktreeById(state.worktreesByRepo, worktreeId)?.lastActivityAt ?? 0)
    : 0
  const paneSources: TabPaneInputSources = {
    entriesByTabId: byTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId
  }
  const ranked: RankedTab[] = tabs.map((tab) => {
    // Agent-status pane keys use the backing terminal tab id, not the unified tab id.
    const terminalTab =
      tab.contentType === 'terminal'
        ? terminalTabs?.find((candidate) => candidate.id === tab.entityId)
        : undefined
    const entries = terminalTab ? (byTabId.get(terminalTab.id) ?? []) : []
    return {
      tab,
      latestAt: latestEventAt(tab, entries, now),
      attention:
        smart && terminalTab
          ? resolveAttention(
              collectTabPaneInputs(terminalTab, worktreeLastActivityAt, paneSources, now),
              now
            )
          : IDLE
    }
  })
  return ranked
    .sort(
      (a, b) =>
        a.attention.cls - b.attention.cls ||
        b.attention.attentionTimestamp - a.attention.attentionTimestamp ||
        b.latestAt - a.latestAt ||
        b.tab.createdAt - a.tab.createdAt
    )
    .map((entry) => entry.tab)
}
