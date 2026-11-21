import type {
  AgentStatusMetadata,
  AgentStatusTiming
} from '../../../store/slices/agent-status/contracts/agent-status-contract'
import {
  normalizeAgentStatusPayload,
  pickHostTurnEnd,
  type ParsedAgentStatusPayload
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'

export function normalizeAgentStatusTiming(data: AgentStatusIpcPayload): AgentStatusTiming {
  return {
    updatedAt: data.receivedAt,
    isReplay: data.isReplay,
    evidenceObservedAt: data.evidenceObservedAt,
    stateStartedAt: data.stateStartedAt,
    ...(Number.isFinite(data.turnStartedAt) ? { turnStartedAt: data.turnStartedAt } : {}),
    ...pickHostTurnEnd(data),
    lastCompletionAt: data.lastCompletionAt
  }
}

export function normalizeAgentStatusEvent(
  data: AgentStatusIpcPayload
): ParsedAgentStatusPayload | null {
  const payload = normalizeAgentStatusPayload({
    state: data.state,
    workingMode: data.workingMode,
    prompt: data.prompt,
    agentType: data.agentType,
    model: data.model,
    toolName: data.toolName,
    toolInput: data.toolInput,
    interactivePrompt: data.interactivePrompt,
    lastAssistantMessage: data.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: data.lastAssistantMessageIsToolOutput,
    interrupted: data.interrupted,
    sessionBoundary: data.sessionBoundary,
    turnCompletedAt: data.turnCompletedAt,
    subagents: data.subagents,
    mainAgent: data.mainAgent
  })
  return payload ? { ...payload, sessionBoundary: data.sessionBoundary === true } : null
}

export function normalizeAgentStatusMetadata(
  data: AgentStatusIpcPayload,
  authorityRestartId?: string
): AgentStatusMetadata | undefined {
  if (
    !data.providerSession &&
    !data.launchToken &&
    data.launchConfig === undefined &&
    !authorityRestartId &&
    !data.paneOwner &&
    data.executionHost !== 'shared' &&
    data.orcaSessionId === undefined
  ) {
    return undefined
  }
  return {
    ...(authorityRestartId ? { authorityRestartId } : {}),
    ...(data.providerSession ? { providerSession: data.providerSession } : {}),
    ...(data.orcaSessionId !== undefined ? { orcaSessionId: data.orcaSessionId } : {}),
    ...(data.launchToken ? { launchToken: data.launchToken } : {}),
    ...(data.launchConfig !== undefined ? { launchConfig: data.launchConfig } : {}),
    ...(data.paneOwner ? { paneOwner: data.paneOwner } : {}),
    ...(data.executionHost === 'shared' ? { executionHost: 'shared' as const } : {})
  }
}
