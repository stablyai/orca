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
import { applyAgentPaneActivityFlags } from '../../../../../../shared/worktree-status-rollup'
import { getTabIdToWorktreeId } from '@/lib/workspace/tabs/tab-worktree-index'

export type WorktreeAgentActivitySummary = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  /** A fresh failed main agent, also while its subagents run; kept apart from clean done. */
  hasFailed: boolean
  /** Fresh interrupted completion, kept separate from clean done outcomes. */
  hasInterrupted: boolean
  /** A fresh end Orca cannot prove, likewise never a clean done. */
  hasUnconfirmed: boolean
  hasLiveDone: boolean
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
  VisibleOrchestrationState & {
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

export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  return getWorktreeAgentActivitySummaries(state).get(worktreeId) ?? EMPTY_SUMMARY
}

function getWorktreeAgentActivitySummaries(
  state: AgentActivityInput
): Map<string, WorktreeAgentActivitySummary> {
  const runtimeAgentOrchestrationByPaneKey = selectVisibleAgentOrchestration(state)
  if (
    agentActivityCache &&
    agentActivityCache.tabsByWorktree === state.tabsByWorktree &&
    agentActivityCache.unifiedTabsByWorktree === state.unifiedTabsByWorktree &&
    agentActivityCache.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    agentActivityCache.agentStatusEpoch === state.agentStatusEpoch &&
    agentActivityCache.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId &&
    agentActivityCache.runtimeAgentOrchestrationByPaneKey === runtimeAgentOrchestrationByPaneKey
  ) {
    return agentActivityCache.summaries
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(state.tabsByWorktree)

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
    if (!isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
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
    agentStatusByPaneKey: state.agentStatusByPaneKey,
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
