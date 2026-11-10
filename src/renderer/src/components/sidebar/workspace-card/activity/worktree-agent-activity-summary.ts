import { unoccupiedSleptAgentEntriesByWorktree } from './worktree-unoccupied-slept-agent-index'
import type { SleepRowsState } from './worktree-slept-agent-index'
import { getSleepSummaries } from './worktree-slept-activity-summary'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import {
  selectVisibleAgentOrchestration,
  type VisibleOrchestrationState
} from '@/runtime/agent-orchestration/visible-agent-orchestration'
import type { AppState } from '@/store/types'
import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../../shared/migration-unsupported-agent-entry'
import {
  mergeAgentStatusOrchestration,
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'

import type { AgentStatusOrchestrationContext } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from '../../../../../../shared/worktree-status-rollup'

export type WorktreeAgentActivitySummary = AgentPaneActivityFlags & {
  hasSleptFailed: boolean
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
  /** Stale rows suppress generated permission labels while preserving native title fallback. */
  stalePaneIdsByTabId: Record<string, ReadonlySet<string>>
}

const EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID: Record<string, ReadonlySet<string>> = {}

const EMPTY_SUMMARY: WorktreeAgentActivitySummary = {
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveMonitoring: false,
  hasFailed: false,
  hasSleptFailed: false,
  hasInterrupted: false,
  hasUnconfirmed: false,
  hasLiveDone: false,
  agentStatusPaneIdsByTabId: EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID,
  stalePaneIdsByTabId: EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID
}

type AgentActivityTabsByWorktree = Record<string, readonly { id: string }[]>

export type AgentActivityInput = Pick<
  AppState,
  'agentStatusEpoch' | 'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId'
> &
  VisibleOrchestrationState &
  SleepRowsState & {
    tabsByWorktree: AgentActivityTabsByWorktree
    runtimeAgentOrchestrationByPaneKey?: AppState['runtimeAgentOrchestrationByPaneKey']
  }

type AgentActivityCache = {
  tabsByWorktree: AgentActivityTabsByWorktree
  unifiedTabsByWorktree: AgentActivityInput['unifiedTabsByWorktree']
  agentStatusByPaneKey: AgentActivityInput['agentStatusByPaneKey']
  agentStatusEpoch: number
  migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId']
  runtimeAgentOrchestrationByPaneKey: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
  summaries: Map<string, WorktreeAgentActivitySummary>
}

let agentActivityCache: AgentActivityCache | null = null
const placedSummaries = new WeakMap<
  WorktreeAgentActivitySummary,
  {
    live: WorktreeAgentActivitySummary
    result: WorktreeAgentActivitySummary
  }
>()

export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  const live = getWorktreeAgentActivitySummaries(state).get(worktreeId) ?? EMPTY_SUMMARY
  const sleeping = unoccupiedSleptAgentEntriesByWorktree(state)
  const slept =
    getSleepSummaries(
      sleeping,
      EMPTY_SUMMARY,
      state.tabsByWorktree,
      selectVisibleAgentOrchestration(state)
    ).get(worktreeId) ?? EMPTY_SUMMARY
  if (slept === EMPTY_SUMMARY) {
    return live
  }
  const previous = placedSummaries.get(slept)
  if (previous?.live === live) {
    return previous.result
  }
  const result = {
    ...live,
    hasPermission: live.hasPermission || slept.hasPermission,
    hasLiveWorking: live.hasLiveWorking || slept.hasLiveWorking,
    hasLiveMonitoring: live.hasLiveMonitoring || slept.hasLiveMonitoring,
    hasFailed: live.hasFailed,
    hasSleptFailed: slept.hasFailed,
    hasInterrupted: live.hasInterrupted || slept.hasInterrupted,
    hasUnconfirmed: live.hasUnconfirmed || slept.hasUnconfirmed,
    hasLiveDone: live.hasLiveDone || slept.hasLiveDone,
    agentStatusPaneIdsByTabId: { ...live.agentStatusPaneIdsByTabId }
  }
  for (const [tabId, ids] of Object.entries(slept.agentStatusPaneIdsByTabId)) {
    result.agentStatusPaneIdsByTabId[tabId] = new Set([
      ...(result.agentStatusPaneIdsByTabId[tabId] ?? []),
      ...ids
    ])
  }
  const equal = previous && summariesEqual(previous.result, result) ? previous.result : result
  placedSummaries.set(slept, { live, result: equal })
  return equal
}

function getWorktreeAgentActivitySummaries(
  state: AgentActivityInput
): Map<string, WorktreeAgentActivitySummary> {
  const runtimeAgentOrchestrationByPaneKey = selectVisibleAgentOrchestration(state)
  const agentStatusByPaneKey = state.agentStatusByPaneKey
  if (
    agentActivityCache &&
    agentActivityCache.tabsByWorktree === state.tabsByWorktree &&
    agentActivityCache.unifiedTabsByWorktree === state.unifiedTabsByWorktree &&
    agentActivityCache.agentStatusByPaneKey === agentStatusByPaneKey &&
    agentActivityCache.agentStatusEpoch === state.agentStatusEpoch &&
    agentActivityCache.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId &&
    agentActivityCache.runtimeAgentOrchestrationByPaneKey === runtimeAgentOrchestrationByPaneKey
  ) {
    return agentActivityCache.summaries
  }

  // Index tabs once per snapshot so per-card summaries cost O(worktrees + agents).
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
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const paneIdentity = parseAgentStatusPaneIdentity(
      paneKey,
      state.unifiedTabsByWorktree
        ? getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).get(paneKey)
        : undefined
    )
    if (!paneIdentity) {
      continue
    }
    const orchestration = mergeAgentStatusOrchestration(
      entry,
      runtimeAgentOrchestrationByPaneKey?.[paneKey]
    )
    const worktreeId = resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId, orchestration)
    if (!worktreeId) {
      continue
    }
    const summary = summaryForWorktree(worktreeId)
    if (entry.restoredUnconfirmed) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
      continue
    }
    if (!entry.sessionBoundary && !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      // Retain stale pane identity to suppress generated permission titles after the row loses authority.
      addStalePaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
      continue
    }
    addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    if (entry.state === 'done') {
      addParentPaneId(summary, orchestration, worktreeId, tabIdToWorktreeId)
    }
    applyAgentPaneActivityFlags(summary, entry)
  }

  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    const worktreeId = entry ? worktreeIdForPaneKey(entry.paneKey, tabIdToWorktreeId) : null
    if (worktreeId) {
      summaryForWorktree(worktreeId).hasPermission = true
    }
  }

  // Reuse equal summaries across freshness epochs so unrelated cards do not rerender.
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
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
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
    previous.hasLiveMonitoring === next.hasLiveMonitoring &&
    previous.hasFailed === next.hasFailed &&
    previous.hasSleptFailed === next.hasSleptFailed &&
    previous.hasInterrupted === next.hasInterrupted &&
    previous.hasUnconfirmed === next.hasUnconfirmed &&
    previous.hasLiveDone === next.hasLiveDone &&
    agentStatusPaneIdsByTabIdEqual(
      previous.agentStatusPaneIdsByTabId,
      next.agentStatusPaneIdsByTabId
    ) &&
    agentStatusPaneIdsByTabIdEqual(previous.stalePaneIdsByTabId, next.stalePaneIdsByTabId)
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

function addAgentStatusPaneId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  paneId: string
): void {
  summary.agentStatusPaneIdsByTabId = withPaneId(summary.agentStatusPaneIdsByTabId, tabId, paneId)
}

function addStalePaneId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  paneId: string
): void {
  summary.stalePaneIdsByTabId = withPaneId(summary.stalePaneIdsByTabId, tabId, paneId)
}

function withPaneId(
  byTabId: Record<string, ReadonlySet<string>>,
  tabId: string,
  paneId: string
): Record<string, ReadonlySet<string>> {
  // Why: the shared empty record is the frozen default for every summary; copy on first write.
  const next = byTabId === EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID ? {} : byTabId
  let paneIds = next[tabId] as Set<string> | undefined
  if (!paneIds) {
    paneIds = new Set<string>()
    next[tabId] = paneIds
  }
  paneIds.add(paneId)
  return next
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
  // Completed workers own stale parent titles only within their attributed worktree.
  if (tabIdToWorktreeId.get(parentPaneIdentity.tabId) !== worktreeId) {
    return
  }
  addAgentStatusPaneId(summary, parentPaneIdentity.tabId, parentPaneIdentity.paneId)
}
