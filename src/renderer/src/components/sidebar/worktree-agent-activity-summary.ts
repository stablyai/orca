import type { AppState } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext
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
  runtimeAgentOrchestrationByPaneKey?: AppState['runtimeAgentOrchestrationByPaneKey']
}

type AgentActivityCache = {
  tabsByWorktree: AgentActivityTabsByWorktree
  agentStatusEpoch: number
  migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId']
  retainedAgentsByPaneKey: AppState['retainedAgentsByPaneKey']
  runtimeAgentOrchestrationByPaneKey: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
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
  const runtimeAgentOrchestrationByPaneKey = state.runtimeAgentOrchestrationByPaneKey
  if (
    agentActivityCache &&
    agentActivityCache.tabsByWorktree === state.tabsByWorktree &&
    agentActivityCache.agentStatusEpoch === state.agentStatusEpoch &&
    agentActivityCache.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId &&
    agentActivityCache.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey &&
    agentActivityCache.runtimeAgentOrchestrationByPaneKey === runtimeAgentOrchestrationByPaneKey
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
    const orchestration = resolveEntryOrchestration(
      entry,
      runtimeAgentOrchestrationByPaneKey?.[paneKey]
    )
    const worktreeId =
      tabIdToWorktreeId.get(paneIdentity.tabId) ??
      entry.worktreeId ??
      worktreeIdForPaneKey(orchestration?.parentPaneKey, tabIdToWorktreeId)
    if (!worktreeId || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const summary = summaryForWorktree(worktreeId)
    addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    if (entry.state === 'done') {
      addParentPaneId(summary, orchestration, worktreeId, tabIdToWorktreeId)
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
    const summary = summaryForWorktree(retained.worktreeId)
    summary.hasRetainedDone = true
    const paneIdentity = parseAgentStatusPaneKey(retained.entry?.paneKey)
    if (paneIdentity) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    }
    const orchestration = resolveEntryOrchestration(
      retained.entry,
      runtimeAgentOrchestrationByPaneKey?.[retained.entry.paneKey]
    )
    addParentPaneId(summary, orchestration, retained.worktreeId, tabIdToWorktreeId)
  }

  agentActivityCache = {
    tabsByWorktree: state.tabsByWorktree,
    agentStatusEpoch: state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    runtimeAgentOrchestrationByPaneKey,
    summaries
  }
  return summaries
}

function resolveEntryOrchestration(
  entry: Pick<AgentStatusEntry, 'orchestration'>,
  runtimeOrchestration: AgentStatusOrchestrationContext | undefined
): AgentStatusOrchestrationContext | undefined {
  if (!entry.orchestration) {
    return runtimeOrchestration
  }
  if (!runtimeOrchestration) {
    return entry.orchestration
  }
  if (
    entry.orchestration.taskId === runtimeOrchestration.taskId &&
    entry.orchestration.dispatchId === runtimeOrchestration.dispatchId
  ) {
    return { ...entry.orchestration, ...runtimeOrchestration }
  }
  return entry.orchestration
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
  paneKey: string | undefined,
  tabIdToWorktreeId: Map<string, string>
): string | null {
  const paneIdentity = parseAgentStatusPaneKey(paneKey)
  return paneIdentity ? (tabIdToWorktreeId.get(paneIdentity.tabId) ?? null) : null
}

function addParentPaneId(
  summary: WorktreeAgentActivitySummary,
  orchestration: AgentStatusOrchestrationContext | undefined,
  worktreeId: string,
  tabIdToWorktreeId: Map<string, string>
): void {
  const parentPaneIdentity = parseAgentStatusPaneKey(orchestration?.parentPaneKey)
  if (!parentPaneIdentity) {
    return
  }
  // Why: a completed worker can be the only visible row for a worktree while
  // its parent pane still carries a stale spinner title. Let that row own the
  // parent pane's title for this worktree without touching other worktrees.
  if (tabIdToWorktreeId.get(parentPaneIdentity.tabId) !== worktreeId) {
    return
  }
  addAgentStatusPaneId(summary, parentPaneIdentity.tabId, parentPaneIdentity.paneId)
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
