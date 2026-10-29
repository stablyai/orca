import { canonicalOrchestrationForRow } from '@/runtime/visible-agent-orchestration'
import { sameAgentStatusTerminalOwner } from '../../../../../shared/agent-status-terminal-owner'
import type { AppState } from '../../types'
import { resolveAgentStatusLiveEntryMainAgent } from './agent-status-live-entry-main-agent'
import { resolveAgentStatusLiveEntryStateHistory } from '../../../../../shared/agent-status-live-entry-state-history'
import { pickHostTurnEnd } from '../../../../../shared/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../../shared/agent-status-ipc-payload'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../../shared/command-code-turn-boundary'
import type {
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-contract'
import { registryEntryMatchesStatus } from './agent-status-launch-config'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration-context'
import { deriveAgentStatusLiveFacts } from './agent-status-live-facts'
import { liveEntryChildFields } from './agent-status-live-entry-children'
import {
  canReuseStatusProviderSession,
  recordLaunchConfigForStatus,
  statusRetainsResumableIdentity
} from '../../../../../shared/agent-resume-record-from-status'

export type AgentStatusLiveEntryBuild = {
  entry: AgentStatusEntry
  existing: AgentStatusEntry | undefined
  existingSleepingRecord: SleepingAgentSessionRecord | undefined
  liveRecoveryRecord: SleepingAgentSessionRecord | null
  launchConfigSource: SleepingAgentLaunchConfig | undefined
  registryEntry: AppState['agentLaunchConfigByPaneKey'][string] | undefined
  registryMatched: boolean
  providerSession: AgentProviderSessionMetadata | undefined
  providerSessionChanged: boolean
  retainsResumableRecoveryIdentity: boolean
  migrationUnsupported: {
    next: Record<string, MigrationUnsupportedPtyEntry>
    changed: boolean
  }
  commandCodeNewTurn: boolean
  sortRelevantChange: boolean
  retentionRelevantChange: boolean
  completionRefreshWorktreeId: string | null
  boundaryResolved: boolean
}

export type AgentStatusLiveEntryRejection = {
  entry: null
  reason: 'stale' | 'suppressed-inherited-terminal'
}

export type AgentStatusLiveEntryArgs = {
  state: AppState
  paneKey: string
  payload: AgentStatusPayload
  terminalTitle?: string
  timing?: AgentStatusTiming
  routing?: AgentStatusRouting
  metadata?: AgentStatusMetadata
  updatedAt: number
}

/** Build one accepted live row and the derived map-update facts, or say why the frame was rejected. */
export function buildAgentStatusLiveEntry(
  args: AgentStatusLiveEntryArgs
): AgentStatusLiveEntryBuild | AgentStatusLiveEntryRejection {
  const { state, paneKey, payload, terminalTitle, timing, routing, metadata, updatedAt } = args
  const existing = state.agentStatusByPaneKey[paneKey]
  if (existing && updatedAt < existing.updatedAt && !timing?.allowOlderTimestamp) {
    return { entry: null, reason: 'stale' }
  }
  const effectiveTitle = terminalTitle ?? existing?.terminalTitle
  const { history, lastCompletedAssistantMessage, stateObservedAt } =
    resolveAgentStatusLiveEntryStateHistory(existing, payload, updatedAt)
  const identity = resolveAgentStatusIdentity({
    existing:
      existing &&
      sameAgentStatusTerminalOwner(
        { connectionId: existing.connectionId ?? null, worktreeId: existing.worktreeId },
        {
          connectionId:
            (routing?.connectionId === undefined ? existing.connectionId : routing.connectionId) ??
            null,
          worktreeId: routing?.worktreeId ?? existing.worktreeId
        }
      )
        ? { ...existing, agentPresence: metadata?.paneOwner }
        : undefined,
    incoming: payload.agentType,
    incomingSession: metadata?.providerSession?.id,
    now: updatedAt
  })
  const commandCodeNewTurn =
    existing !== undefined &&
    isCommandCodeNewTurnWhileWorking({
      agentType: identity.agentType,
      previousState: existing.state,
      incomingState: payload.state,
      previousPrompt: existing.prompt,
      incomingPrompt: payload.prompt,
      previousPromptInteractionKey: existing.promptInteractionKey,
      incomingPromptInteractionKey: payload.promptInteractionKey
    })
  const promptInteractionKey =
    payload.promptInteractionKey ??
    (payload.prompt === existing?.prompt ? existing?.promptInteractionKey : undefined)
  const stateStartedAt =
    timing?.stateStartedAt ??
    (commandCodeNewTurn
      ? updatedAt
      : existing && existing.state === payload.state
        ? existing.stateStartedAt
        : updatedAt)
  // Clockless OSC repaints retain host turn start only within the same state; undated transitions must not inherit another turn.
  const turnStartedAt =
    timing?.turnStartedAt ??
    (existing && existing.state === payload.state ? existing.turnStartedAt : undefined)
  // Why: the end stamp and its disposition are one host fact, inherited together.
  const turnEnd =
    timing?.turnEndedAt !== undefined || timing?.turnEndDisposition !== undefined
      ? pickHostTurnEnd(timing)
      : existing && existing.state === payload.state
        ? pickHostTurnEnd(existing)
        : {}
  if (
    existing &&
    shouldSuppressInheritedTerminalStatus({
      inheritedFromActivePane: identity.inheritedFromActivePane
    })
  ) {
    return { entry: null, reason: 'suppressed-inherited-terminal' }
  }
  const runtimeOrchestration = canonicalOrchestrationForRow(state, paneKey)
  const runtimeMergedOrchestration = runtimeOrchestration
    ? mergeCurrentOrchestrationContext(existing?.orchestration, runtimeOrchestration)
    : undefined
  const payloadMergedOrchestration = payload.orchestration
    ? mergeCurrentOrchestrationContext(
        runtimeMergedOrchestration ?? existing?.orchestration,
        payload.orchestration
      )
    : undefined
  const orchestration =
    payloadMergedOrchestration ??
    runtimeMergedOrchestration ??
    (payload.state === 'done' ? existing?.orchestration : undefined)
  const canReuseExistingProviderSession = canReuseStatusProviderSession(existing, {
    agentType: identity.agentType,
    state: payload.state
  })
  const providerSession =
    metadata?.providerSession ??
    (canReuseExistingProviderSession ? existing.providerSession : undefined)
  const existingProviderSession = canReuseExistingProviderSession
    ? existing.providerSession
    : undefined
  const providerSessionChanged =
    Boolean(metadata?.providerSession && existingProviderSession) &&
    !agentProviderSessionsEqual(
      identity.agentType,
      metadata?.providerSession,
      existingProviderSession
    )
  const statusTabId = routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
  const statusTerminalHandle = routing?.terminalHandle ?? existing?.terminalHandle
  const registryEntry = state.agentLaunchConfigByPaneKey[paneKey]
  const registryMatched = registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey,
    agentType: identity.agentType,
    tabId: statusTabId,
    terminalHandle: statusTerminalHandle,
    launchToken: metadata?.launchToken,
    providerSession,
    existingProviderSession,
    providerSessionChanged
  })
  const matchedRegistryLaunchConfig = registryMatched ? registryEntry?.launchConfig : undefined
  const existingSleepingRecord = state.sleepingAgentSessionsByPaneKey[paneKey]
  const retainsResumableRecoveryIdentity = statusRetainsResumableIdentity(
    { agentType: identity.agentType, state: payload.state },
    providerSession
  )
  const matchedSleepingLaunchConfig =
    payload.state !== 'done' || retainsResumableRecoveryIdentity
      ? recordLaunchConfigForStatus(existingSleepingRecord, {
          agentType: identity.agentType,
          providerSession
        })
      : undefined
  const launchConfigSource =
    (payload.state !== 'done' && !providerSessionChanged && metadata?.launchToken
      ? metadata?.launchConfig
      : undefined) ??
    matchedRegistryLaunchConfig ??
    matchedSleepingLaunchConfig
  const mainAgent = resolveAgentStatusLiveEntryMainAgent(existing, payload, identity.agentType)
  const programStatus =
    payload.programStatus === undefined ? existing?.programStatus : payload.programStatus
  const entry: AgentStatusEntry = {
    state: payload.state,
    workingMode: payload.workingMode,
    prompt: payload.prompt,
    updatedAt,
    // Clockless OSC/launch writes are fresh evidence; never inherit prior observation time.
    ...(timing?.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: timing.evidenceObservedAt }
      : {}),
    ...(metadata?.structuredHostOwned === true ? { structuredHostOwned: true as const } : {}),
    stateStartedAt,
    stateObservedAt,
    ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
    ...turnEnd,
    agentType: identity.agentType,
    model:
      payload.model ?? (existing?.agentType === identity.agentType ? existing.model : undefined),
    ...(payload.modelSwitchCommand ? { modelSwitchCommand: payload.modelSwitchCommand } : {}),
    paneKey,
    terminalHandle: statusTerminalHandle,
    worktreeId:
      routing?.worktreeId ??
      existing?.worktreeId ??
      findAgentPaneWorktreeId(state, paneKey) ??
      undefined,
    ...(routing?.connectionId !== undefined
      ? { connectionId: routing.connectionId }
      : existing?.connectionId !== undefined
        ? { connectionId: existing.connectionId }
        : state.sleepingAgentSessionsByPaneKey[paneKey]?.connectionId !== undefined
          ? { connectionId: state.sleepingAgentSessionsByPaneKey[paneKey].connectionId }
          : {}),
    tabId: statusTabId,
    terminalTitle: effectiveTitle,
    stateHistory: history,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
    interactivePrompt: payload.interactivePrompt,
    lastAssistantMessage: payload.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: payload.lastAssistantMessageIsToolOutput,
    ...(lastCompletedAssistantMessage ? { lastCompletedAssistantMessage } : {}),
    orchestration,
    ...(payload.subagentObservation ? { subagentObservation: payload.subagentObservation } : {}),
    ...liveEntryChildFields(existing, payload),
    ...(mainAgent ? { mainAgent } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(metadata?.terminalResumeEligible === false
      ? { terminalResumeEligible: false as const }
      : {}),
    ...(promptInteractionKey ? { promptInteractionKey } : {}),
    ...(payload.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    acceptedStatusSeq: (existing?.acceptedStatusSeq ?? 0) + 1,
    ...(payload.observation ? { observation: payload.observation } : {}),
    ...(programStatus ? { programStatus } : {}),
    interrupted: payload.interrupted,
    sessionBoundary:
      payload.sessionBoundary ??
      (existing?.state === 'done' &&
      payload.state === 'done' &&
      payload.lastAssistantMessage === undefined &&
      payload.prompt === existing.prompt
        ? existing.sessionBoundary
        : undefined)
  }
  const facts = deriveAgentStatusLiveFacts({
    state,
    paneKey,
    entry,
    existing,
    launchConfigSource,
    retainsResumableRecoveryIdentity,
    commandCodeNewTurn,
    updatedAt
  })
  return {
    entry,
    existing,
    ...facts,
    launchConfigSource,
    providerSession,
    providerSessionChanged,
    registryEntry,
    registryMatched,
    retainsResumableRecoveryIdentity,
    commandCodeNewTurn
  }
}
