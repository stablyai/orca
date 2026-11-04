import {
  readAgentProcessIdentity,
  type AgentProcessIdentity
} from './agent-status/process/agent-process-presence'
import { isRecord } from './agent-status/child-work/agent-status-child-work-value-guards'
import { parsePaneKey } from './workspace-layout/stable-pane-id'

export const TERMINAL_USAGE_LIMIT_SOURCE_METHOD = 'agent_hook.validateUsageLimit'

export type TerminalUsageLimitSourceRequest = {
  paneKey: string
  sessionId: string
  turnEndedAt: number
  source: 'claude' | 'codex'
  launchToken?: string
  agentProcess?: AgentProcessIdentity
}

export type TerminalUsageLimitSourceResult = { status: 'current' | 'changed' | 'unavailable' }

export function readTerminalUsageLimitSourceRequest(
  value: unknown
): TerminalUsageLimitSourceRequest | null {
  if (
    !isRecord(value) ||
    typeof value.paneKey !== 'string' ||
    value.paneKey.length > 256 ||
    !parsePaneKey(value.paneKey) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    value.sessionId.length > 512 ||
    typeof value.turnEndedAt !== 'number' ||
    !Number.isFinite(value.turnEndedAt) ||
    value.turnEndedAt <= 0 ||
    (value.source !== 'claude' && value.source !== 'codex') ||
    (value.launchToken !== undefined &&
      (typeof value.launchToken !== 'string' || value.launchToken.length > 512))
  ) {
    return null
  }
  const agentProcess = readAgentProcessIdentity(value.agentProcess)
  if (value.agentProcess !== undefined && !agentProcess) {
    return null
  }
  return {
    paneKey: value.paneKey,
    sessionId: value.sessionId,
    turnEndedAt: value.turnEndedAt,
    source: value.source,
    ...(value.launchToken !== undefined ? { launchToken: value.launchToken } : {}),
    ...(agentProcess ? { agentProcess } : {})
  }
}
