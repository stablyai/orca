import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from './agent-status-contract'

/** Main's report wins; a renderer-local write keeps the row's account while the agent is the same. */
export function claudeAccountIdField(
  existing: AgentStatusEntry | undefined,
  payload: AgentStatusPayload,
  agentType: AgentType | undefined
): { claudeAccountId?: string } {
  const claudeAccountId =
    payload.claudeAccountId !== undefined
      ? (payload.claudeAccountId ?? undefined)
      : existing?.agentType === agentType
        ? existing?.claudeAccountId
        : undefined
  return claudeAccountId ? { claudeAccountId } : {}
}
