import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import {
  agentChildWorkProjectionCandidateFromBackgroundTask,
  projectAgentChildWorkLegacySubagents
} from '../../../../shared/agent-status-child-work-projection'
import {
  continueMainAgentStatus,
  isAgentStatusHeldOpenByChildWork,
  mainAgentTurnInterrupted
} from '../../../../shared/agent-lead-status-fold'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import {
  agentChildWorkViewsEqual,
  decodeAgentChildWorkViews
} from '../../../../shared/agent-status-child-work-view-wire'
import {
  agentSubagentsEqual,
  mainAgentStatusEqual,
  type AgentSubagentSnapshot
} from '../../../../shared/agent-status-types'
import { structuredChildWorkLegacySubagents } from '../../../../shared/structured-agent-session-child-work-legacy'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import {
  structuredAgentSessionDatedMainAgent,
  structuredAgentSessionRowStateStartedAt
} from '../../../../shared/structured-agent-session-status-started-at'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import type { AgentStatusBatchTransaction } from '@/store/slices/agent-status/agent-status-contract'
import type { StructuredTab } from './structured-agent-session-tabs'

/** Copy modern child views verbatim; convert legacy host task lists and retain the legacy live-agent roster. */
function childWorkFor(summary: AgentSessionStatusSummary): {
  children?: AgentChildWorkView[]
  subagents?: AgentSubagentSnapshot[]
} {
  const children = decodeAgentChildWorkViews(summary.children)
  if (children) {
    const subagents = structuredChildWorkLegacySubagents(children, summary.agent)
    return { children, ...(subagents ? { subagents } : {}) }
  }
  const subagents = summary.backgroundTasks
    ? projectAgentChildWorkLegacySubagents(
        summary.backgroundTasks.map(agentChildWorkProjectionCandidateFromBackgroundTask)
      )
    : undefined
  return subagents ? { subagents } : {}
}

/** Refused creates leave no host session, so publish their launch failure like host-reported start failures. */
function projectFailedStart(
  transaction: AgentStatusBatchTransaction,
  tab: StructuredTab,
  paneKey: string,
  failedAt: number
): void {
  const store = transaction.getState()
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === 'done' &&
    agentMainAgentVerdict(current) === 'failure' &&
    current.updatedAt === failedAt &&
    current.stateStartedAt === failedAt &&
    current.agentType === tab.agentSessionAgent &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId
  ) {
    return
  }
  const { state, mainAgent } = structuredAgentSessionAgentStatus({
    status: 'idle',
    turnOutcome: 'failure'
  })
  transaction.apply({
    paneKey,
    payload: {
      state,
      mainAgent: { ...mainAgent, stateStartedAt: failedAt },
      interrupted: false,
      prompt: '',
      agentType: tab.agentSessionAgent,
      sessionBoundary: false
    },
    terminalTitle: tab.label,
    // Keep failure dating across restart, replacing even newer pane rows without refreshing its age.
    timing: { updatedAt: failedAt, allowOlderTimestamp: true, stateStartedAt: failedAt },
    routing: { tabId: tab.id, worktreeId: tab.worktreeId },
    metadata: { terminalResumeEligible: false }
  })
}

export function projectStatus(
  transaction: AgentStatusBatchTransaction,
  tab: StructuredTab,
  summary: AgentSessionStatusSummary | null,
  observation: 'live' | 'unverifiable',
  launchFailedAt: number | null
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = transaction.getState()
  if (!summary?.status) {
    if (launchFailedAt !== null) {
      projectFailedStart(transaction, tab, paneKey, launchFailedAt)
    } else if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const { children, subagents } = childWorkFor(summary)
  // Shared with `worktree ps`, so the CLI and this row cannot disagree about one session.
  const agentStatus = structuredAgentSessionAgentStatus({
    status: summary.status,
    childWork: children ?? summary.backgroundTasks,
    turnOutcome: summary.turnOutcome,
    ...(summary.stopping ? { stopping: summary.stopping } : {})
  })
  const current = store.agentStatusByPaneKey?.[paneKey]
  // Same continuity rule as the host ingest, on the main agent's own clock.
  const mainAgent = continueMainAgentStatus(
    current?.mainAgent,
    structuredAgentSessionDatedMainAgent(agentStatus.mainAgent, summary),
    summary.updatedAt
  )
  const desired = {
    state: agentStatus.state,
    ...(agentStatus.workingMode ? { workingMode: agentStatus.workingMode } : {}),
    mainAgent,
    // Derived from `mainAgent`, so the equality below needs no second check of it.
    interrupted: mainAgentTurnInterrupted(mainAgent),
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    // Project host journal model, live tool and settled reply fields as hook rows do.
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
    ...(summary.lastAssistantMessage ? { lastAssistantMessage: summary.lastAssistantMessage } : {}),
    ...(subagents ? { subagents } : {}),
    ...(children ? { children } : {}),
    ...(subagents || children ? { subagentObservation: observation } : {}),
    sessionBoundary: false
  } as const
  if (
    current?.state === desired.state &&
    current.workingMode === desired.workingMode &&
    mainAgentStatusEqual(current.mainAgent, desired.mainAgent) &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    // A row keeps the last model it was told about, so only a reported one can differ.
    (summary.model === undefined || current.model === summary.model) &&
    current.toolName === summary.toolName &&
    current.toolInput === summary.toolInput &&
    current.lastAssistantMessage === summary.lastAssistantMessage &&
    agentSubagentsEqual(current.subagents, subagents) &&
    agentChildWorkViewsEqual(current.children, children) &&
    current.subagentObservation === desired.subagentObservation &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.updatedAt === summary.updatedAt &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
    current.structuredHostOwned === summary.hostExecutionOwned &&
    agentProviderSessionsEqual(
      tab.agentSessionAgent,
      current.providerSession,
      summary.providerSession
    )
  ) {
    return
  }
  transaction.apply({
    paneKey,
    payload: desired,
    terminalTitle: tab.label,
    timing: {
      updatedAt: summary.updatedAt,
      // This ordered host feed can correct a legacy publication clock after upgrade.
      allowOlderTimestamp: true,
      // Match host continuity: monitoring/working labels are distinct states and must restart their own clocks.
      stateStartedAt:
        structuredAgentSessionRowStateStartedAt(desired, summary) ??
        (desired.state !== 'done' &&
        current?.state === desired.state &&
        current.workingMode === desired.workingMode
          ? current.stateStartedAt
          : summary.updatedAt),
      // Child-only work outlives the lead’s journal clock; date its evidence by local observation, as host ingest does.
      evidenceObservedAt: isAgentStatusHeldOpenByChildWork(desired) ? Date.now() : summary.updatedAt
    },
    routing: { tabId: tab.id, worktreeId: tab.worktreeId },
    metadata: {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false,
      ...(summary.hostExecutionOwned ? { structuredHostOwned: true as const } : {})
    }
  })
}
