import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { agentEntryCompletionAt } from '../../../../shared/agent-status/lifecycle/agent-completion-time'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
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

/** Only this card's inputs invalidate its ranking; epoch ticks matter when freshness changes. */
export function worktreeLeadingTabOrderInputs(state: AppState, worktreeId: string): unknown[] {
  const tabs = state.unifiedTabsByWorktree[worktreeId]
  const smart = state.sortBy === 'smart'
  const inputs: unknown[] = [
    tabs,
    state.tabsByWorktree[worktreeId],
    state.sortBy,
    smart
      ? getIndexedWorktreesById(selectWorktreesByRepo(state), worktreeId)[0]?.lastActivityAt
      : undefined
  ]
  const byTabId = entriesByTabId(state)
  const now = Date.now()
  const addEntries = (entries: readonly AgentStatusEntry[]): void => {
    for (const entry of entries) {
      inputs.push(entry, isAgentStatusFresh(entry, now))
      if (smart && entry.state === 'done') {
        const completedAt = agentEntryCompletionAt(entry)
        inputs.push(completedAt !== null && now - completedAt <= AGENT_STATUS_STALE_AFTER_MS)
      }
    }
  }
  for (const tab of tabs ?? []) {
    if (tab.contentType === 'terminal') {
      const entries = byTabId.get(tab.entityId) ?? []
      inputs.push(entries.length, state.terminalLayoutsByTabId[tab.entityId])
      addEntries(entries)
      if (smart) {
        inputs.push(state.ptyIdsByTabId[tab.entityId], state.runtimePaneTitlesByTabId[tab.entityId])
      }
    } else if (tab.contentType === 'agent-session') {
      const entry = state.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
      inputs.push(entry)
      if (entry) {
        addEntries([entry])
      }
    }
  }
  return inputs
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
  const terminalById = new Map(terminalTabs?.map((tab) => [tab.id, tab]))
  const worktreeLastActivityAt = smart
    ? (getIndexedWorktreesById(selectWorktreesByRepo(state), worktreeId)[0]?.lastActivityAt ?? 0)
    : 0
  const paneSources: TabPaneInputSources = {
    entriesByTabId: byTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId
  }
  const ranked: RankedTab[] = tabs.map((tab) => {
    // Agent-status pane keys use the backing terminal tab id, not the unified tab id.
    const terminalTab = tab.contentType === 'terminal' ? terminalById.get(tab.entityId) : undefined
    const nativeEntry =
      tab.contentType === 'agent-session'
        ? state.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
        : undefined
    const entries = terminalTab
      ? (byTabId.get(terminalTab.id) ?? [])
      : nativeEntry
        ? [nativeEntry]
        : []
    return {
      tab,
      latestAt: latestEventAt(tab, entries, now),
      attention: smart
        ? resolveAttention(
            terminalTab
              ? collectTabPaneInputs(terminalTab, worktreeLastActivityAt, paneSources, now)
              : entries.map((entry) => ({ kind: 'hook', entry, hasLivePty: false })),
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
