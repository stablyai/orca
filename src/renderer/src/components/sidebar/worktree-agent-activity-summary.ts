import type { AppState } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

export type WorktreeAgentActivitySummary = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
}

const EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID: Record<string, ReadonlySet<string>> = {}

const EMPTY_SUMMARY: WorktreeAgentActivitySummary = {
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveDone: false,
  hasRetainedDone: false,
  agentStatusPaneIdsByTabId: EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID
}

type AgentActivityTabsByWorktree = Record<string, readonly { id: string }[]>

export type AgentActivityInput = Pick<
  AppState,
  | 'agentStatusEpoch'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
> & {
  tabsByWorktree: AgentActivityTabsByWorktree
}

type AgentActivityCache = {
  tabsByWorktree: AgentActivityTabsByWorktree
  agentStatusEpoch: number
  migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId']
  retainedAgentsByPaneKey: AppState['retainedAgentsByPaneKey']
  summaries: Map<string, WorktreeAgentActivitySummary>
}

let agentActivityCache: AgentActivityCache | null = null

export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  return getWorktreeAgentActivitySummaries(state).get(worktreeId) ?? EMPTY_SUMMARY
}

function getWorktreeAgentActivitySummaries(
  state: AgentActivityInput
): Map<string, WorktreeAgentActivitySummary> {
  if (
    agentActivityCache &&
    agentActivityCache.tabsByWorktree === state.tabsByWorktree &&
    agentActivityCache.agentStatusEpoch === state.agentStatusEpoch &&
    agentActivityCache.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId &&
    agentActivityCache.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey
  ) {
    return agentActivityCache.summaries
  }

  // Why: status dots render once per visible worktree. Build the tab/worktree
  // index once per store snapshot so agent pings are O(worktrees + agents),
  // not O(worktrees * agents).
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }

  const summaries = new Map<string, WorktreeAgentActivitySummary>()
  const summaryForWorktree = (worktreeId: string): WorktreeAgentActivitySummary => {
    let summary = summaries.get(worktreeId)
    if (!summary) {
      summary = { ...EMPTY_SUMMARY }
      summaries.set(worktreeId, summary)
    }
    return summary
  }

  const now = Date.now()
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const paneIdentity = parseAgentStatusPaneKey(paneKey)
    if (!paneIdentity) {
      continue
    }
    const worktreeId = tabIdToWorktreeId.get(paneIdentity.tabId) ?? null
    if (!worktreeId || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const summary = summaryForWorktree(worktreeId)
    addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    applyLiveAgentState(summary, entry)
  }

  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    const worktreeId = entry ? worktreeIdForPaneKey(entry.paneKey, tabIdToWorktreeId) : null
    if (worktreeId) {
      summaryForWorktree(worktreeId).hasPermission = true
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey ?? {})) {
    const summary = summaryForWorktree(retained.worktreeId)
    summary.hasRetainedDone = true
    const paneIdentity = parseAgentStatusPaneKey(retained.entry?.paneKey)
    if (paneIdentity) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    }
  }

  agentActivityCache = {
    tabsByWorktree: state.tabsByWorktree,
    agentStatusEpoch: state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    summaries
  }
  return summaries
}

function applyLiveAgentState(
  summary: WorktreeAgentActivitySummary,
  entry: Pick<AgentStatusEntry, 'state'>
): void {
  if (entry.state === 'blocked' || entry.state === 'waiting') {
    summary.hasPermission = true
  } else if (entry.state === 'working') {
    summary.hasLiveWorking = true
  } else if (entry.state === 'done') {
    summary.hasLiveDone = true
  }
}

function addAgentStatusPaneId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  paneId: string
): void {
  if (summary.agentStatusPaneIdsByTabId === EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID) {
    summary.agentStatusPaneIdsByTabId = {}
  }
  let paneIds = summary.agentStatusPaneIdsByTabId[tabId] as Set<string> | undefined
  if (!paneIds) {
    paneIds = new Set<string>()
    summary.agentStatusPaneIdsByTabId[tabId] = paneIds
  }
  paneIds.add(paneId)
}

function worktreeIdForPaneKey(
  paneKey: string,
  tabIdToWorktreeId: Map<string, string>
): string | null {
  const paneIdentity = parseAgentStatusPaneKey(paneKey)
  return paneIdentity ? (tabIdToWorktreeId.get(paneIdentity.tabId) ?? null) : null
}

function parseAgentStatusPaneKey(
  paneKey: string | undefined
): { tabId: string; paneId: string } | null {
  if (!paneKey) {
    return null
  }
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return { tabId: parsed.tabId, paneId: parsed.leafId }
  }

  const legacy = parseLegacyNumericPaneKey(paneKey)
  // Why: imported/restored agent rows can still carry pre-UUID pane keys.
  // Keep their numeric pane id so the matching runtime title cannot revive
  // a stale spinner after the row reports done.
  return legacy ? { tabId: legacy.tabId, paneId: legacy.numericPaneId } : null
}
