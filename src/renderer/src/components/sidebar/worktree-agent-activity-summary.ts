import type { AppState } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  mergeAgentStatusOrchestration,
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from '@/lib/agent-status-worktree-attribution'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'

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
    const paneIdentity = parseAgentStatusPaneIdentity(paneKey)
    if (!paneIdentity) {
      continue
    }
    const orchestration = mergeAgentStatusOrchestration(
      entry,
      runtimeAgentOrchestrationByPaneKey?.[paneKey]
    )
    const worktreeId = resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId, orchestration)
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
    const paneIdentity = parseAgentStatusPaneIdentity(retained.entry?.paneKey)
    if (paneIdentity) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    }
    const orchestration = mergeAgentStatusOrchestration(
      retained.entry,
      runtimeAgentOrchestrationByPaneKey?.[retained.entry.paneKey]
    )
    addParentPaneId(summary, orchestration, retained.worktreeId, tabIdToWorktreeId)
  }

  // Why: epoch changes rebuild every summary, so reuse structurally equal results
  // to keep unrelated worktree subscriptions from scheduling card renders.
  const previousSummaries = agentActivityCache?.summaries
  if (previousSummaries) {
    for (const [worktreeId, summary] of summaries) {
      const previous = previousSummaries.get(worktreeId)
      if (previous && summariesEqual(previous, summary)) {
        summaries.set(worktreeId, previous)
      }
    }
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

function summariesEqual(
  previous: WorktreeAgentActivitySummary,
  next: WorktreeAgentActivitySummary
): boolean {
  return (
    previous.hasPermission === next.hasPermission &&
    previous.hasLiveWorking === next.hasLiveWorking &&
    previous.hasLiveDone === next.hasLiveDone &&
    previous.hasRetainedDone === next.hasRetainedDone &&
    agentStatusPaneIdsByTabIdEqual(
      previous.agentStatusPaneIdsByTabId,
      next.agentStatusPaneIdsByTabId
    )
  )
}

function agentStatusPaneIdsByTabIdEqual(
  previous: Record<string, ReadonlySet<string>>,
  next: Record<string, ReadonlySet<string>>
): boolean {
  if (previous === next) {
    return true
  }
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== Object.keys(next).length) {
    return false
  }
  for (const tabId of previousKeys) {
    const previousPaneIds = previous[tabId]
    const nextPaneIds = next[tabId]
    if (!nextPaneIds || previousPaneIds.size !== nextPaneIds.size) {
      return false
    }
    for (const paneId of previousPaneIds) {
      if (!nextPaneIds.has(paneId)) {
        return false
      }
    }
  }
  return true
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
  const paneIdentity = parseAgentStatusPaneIdentity(paneKey)
  return paneIdentity ? (tabIdToWorktreeId.get(paneIdentity.tabId) ?? null) : null
}

function addParentPaneId(
  summary: WorktreeAgentActivitySummary,
  orchestration: AgentStatusOrchestrationContext | undefined,
  worktreeId: string,
  tabIdToWorktreeId: Map<string, string>
): void {
  const parentPaneIdentity = parseAgentStatusPaneIdentity(orchestration?.parentPaneKey)
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
