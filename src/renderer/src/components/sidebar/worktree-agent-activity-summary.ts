import type { AppState } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type WorktreeAgentActivitySummary = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  freshHookLeafIdsByTabId: Record<string, ReadonlySet<string>>
}

const EMPTY_HOOK_LEAF_IDS_BY_TAB_ID: Record<string, ReadonlySet<string>> = {}

const EMPTY_SUMMARY: WorktreeAgentActivitySummary = {
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveDone: false,
  hasRetainedDone: false,
  freshHookLeafIdsByTabId: EMPTY_HOOK_LEAF_IDS_BY_TAB_ID
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
    const parsed = parsePaneKey(paneKey)
    const worktreeId = parsed
      ? (tabIdToWorktreeId.get(parsed.tabId) ?? null)
      : worktreeIdForLegacyPaneKey(paneKey, tabIdToWorktreeId)
    if (!worktreeId || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const summary = summaryForWorktree(worktreeId)
    if (parsed) {
      addFreshHookLeafId(summary, parsed.tabId, parsed.leafId)
    }
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
    summaryForWorktree(retained.worktreeId).hasRetainedDone = true
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

function addFreshHookLeafId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  leafId: string
): void {
  if (summary.freshHookLeafIdsByTabId === EMPTY_HOOK_LEAF_IDS_BY_TAB_ID) {
    summary.freshHookLeafIdsByTabId = {}
  }
  let leafIds = summary.freshHookLeafIdsByTabId[tabId] as Set<string> | undefined
  if (!leafIds) {
    leafIds = new Set<string>()
    summary.freshHookLeafIdsByTabId[tabId] = leafIds
  }
  leafIds.add(leafId)
}

function worktreeIdForPaneKey(
  paneKey: string,
  tabIdToWorktreeId: Map<string, string>
): string | null {
  const parsed = parsePaneKey(paneKey)
  return parsed
    ? (tabIdToWorktreeId.get(parsed.tabId) ?? null)
    : worktreeIdForLegacyPaneKey(paneKey, tabIdToWorktreeId)
}

function worktreeIdForLegacyPaneKey(
  paneKey: string,
  tabIdToWorktreeId: Map<string, string>
): string | null {
  const tabId = getPaneKeyTabId(paneKey)
  return tabId ? (tabIdToWorktreeId.get(tabId) ?? null) : null
}

function getPaneKeyTabId(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId
  }

  // Why: restored snapshots and older test fixtures can still carry the
  // pre-stable-pane-id `tabId:numericPaneId` key; status only needs tab scope.
  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0 || sepIdx !== paneKey.lastIndexOf(':') || sepIdx === paneKey.length - 1) {
    return null
  }
  return paneKey.slice(0, sepIdx)
}
