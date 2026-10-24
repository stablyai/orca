import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'
import type { AgentStatusMetadata } from '../../store/slices/agent-status-contract'
import {
  normalizeAgentStatusPayload,
  pickHostTurnEnd,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'

export function normalizeAgentStatusEvent(
  data: AgentStatusIpcPayload
): ParsedAgentStatusPayload | null {
  return normalizeAgentStatusPayload({
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
}

export function normalizeAgentStatusMetadata(
  data: AgentStatusIpcPayload,
  authorityRestartId?: string
): AgentStatusMetadata | undefined {
  if (!data.providerSession && !data.launchToken && !authorityRestartId) {
    return undefined
  }
  return {
    ...(authorityRestartId ? { authorityRestartId } : {}),
    ...(data.providerSession ? { providerSession: data.providerSession } : {}),
    ...(data.launchToken ? { launchToken: data.launchToken } : {})
  }
}

export function agentHookNotificationSnapshot(
  data: AgentStatusIpcPayload,
  payload: AgentCompletionStatusSnapshot,
  connectionId: string | null | undefined,
  authorityRestartId: string | undefined,
  replayed: boolean
): AgentCompletionStatusSnapshot {
  return typeof data.stateStartedAt === 'number'
    ? {
        ...payload,
        stateStartedAt: data.stateStartedAt,
        ...pickHostTurnEnd(data),
        runId: data.runId,
        executionId: data.executionId,
        terminalHandle: data.terminalHandle,
        connectionId,
        authorityRestartId,
        turnStartedAt: data.turnStartedAt,
        isReplay: replayed,
        restoredUnconfirmed: data.restoredUnconfirmed
      }
    : { ...payload, ...pickHostTurnEnd(data) }
}
