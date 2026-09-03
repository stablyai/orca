import type { AppState } from '../types'
import {
  AGENT_STATE_HISTORY_MAX,
  agentSubagentsEqual,
  type MigrationUnsupportedPtyEntry,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../shared/command-code-turn-boundary'
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
  if (existing && updatedAt < existing.updatedAt) {
    return { entry: null, reason: 'stale' }
  }
  const effectiveTitle = terminalTitle ?? existing?.terminalTitle
  let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
  let lastCompletedAssistantMessage = existing?.lastCompletedAssistantMessage
  const boundaryLandsOnRealDone =
    existing?.state === 'done' &&
    existing.sessionBoundary !== true &&
    payload.state === 'done' &&
    payload.sessionBoundary === true
  if (
    existing &&
    (existing.state !== payload.state || boundaryLandsOnRealDone) &&
    !(existing.state === 'done' && existing.sessionBoundary === true)
  ) {
    history = [
      ...history,
      {
        state: existing.state,
        prompt: existing.prompt,
        startedAt: existing.stateStartedAt,
        interrupted: existing.interrupted
      }
    ]
    if (history.length > AGENT_STATE_HISTORY_MAX) {
      history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
    }
    if (existing.state === 'done') {
      lastCompletedAssistantMessage = existing.lastAssistantMessage
    }
  }
  const identity = resolveAgentStatusIdentity({
    existing: existing
      ? {
          agentType: existing.agentType,
          state: existing.state,
          updatedAt: existing.updatedAt,
          restoredUnconfirmed: existing.restoredUnconfirmed
        }
      : undefined,
    incoming: payload.agentType,
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
  if (
    existing &&
    shouldSuppressInheritedTerminalStatus({
      inheritedFromActivePane: identity.inheritedFromActivePane,
      incomingState: payload.state
    })
  ) {
    return { entry: null, reason: 'suppressed-inherited-terminal' }
  }
  const runtimeOrchestration = state.runtimeAgentOrchestrationByPaneKey[paneKey]
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
  const canReuseExistingProviderSession =
    existing?.agentType === identity.agentType &&
    (existing.state !== 'done' || payload.state === 'done')
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
  const retainsResumableRecoveryIdentity =
    payload.state === 'done' &&
    isResumableTuiAgent(identity.agentType) &&
    providerSession !== undefined &&
    getAgentResumeArgv(identity.agentType, providerSession) !== null
  const matchedSleepingLaunchConfig =
    (payload.state !== 'done' || retainsResumableRecoveryIdentity) &&
    existingSleepingRecord?.launchConfig &&
    existingSleepingRecord.agent === identity.agentType &&
    providerSession &&
    agentProviderSessionsEqual(
      identity.agentType,
      existingSleepingRecord.providerSession,
      providerSession
    )
      ? existingSleepingRecord.launchConfig
      : undefined
  const launchConfigSource =
    (payload.state !== 'done' && !providerSessionChanged && metadata?.launchToken
      ? metadata?.launchConfig
      : undefined) ??
    matchedRegistryLaunchConfig ??
    matchedSleepingLaunchConfig
  const entry: AgentStatusEntry = {
    state: payload.state,
    workingMode: payload.workingMode,
    prompt: payload.prompt,
    updatedAt,
    // Why: a writer that carries no observation clock (OSC bytes, launch seeds) is itself
    // fresh evidence, so it must not inherit the previous row's older observation time.
    ...(timing?.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: timing.evidenceObservedAt }
      : {}),
    stateStartedAt,
    agentType: identity.agentType,
    model:
      payload.model ?? (existing?.agentType === identity.agentType ? existing.model : undefined),
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
    subagents: agentSubagentsEqual(existing?.subagents, payload.subagents)
      ? existing?.subagents
      : payload.subagents,
    ...(providerSession ? { providerSession } : {}),
    ...(metadata?.terminalResumeEligible === false
      ? { terminalResumeEligible: false as const }
      : {}),
    ...(promptInteractionKey ? { promptInteractionKey } : {}),
    ...(payload.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    acceptedStatusSeq: (existing?.acceptedStatusSeq ?? 0) + 1,
    ...(payload.observation ? { observation: payload.observation } : {}),
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
