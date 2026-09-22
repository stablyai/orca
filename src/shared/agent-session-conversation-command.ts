export type AgentSessionConversationCommand = 'clear' | 'compact'

export type AgentSessionConversationCommandResult = {
  command: AgentSessionConversationCommand
  state: 'completed' | 'unknown'
  replacementSessionId?: string
  error?: string
}

export type AgentSessionConversationCommandRecord = AgentSessionConversationCommandResult & {
  runtimeFence?: number
  operationId: string
  callerKey: string
  phase: 'prepared' | 'committed'
}

export function isAgentSessionConversationCommandResult(
  value: unknown
): value is AgentSessionConversationCommandResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const row = value as AgentSessionConversationCommandResult
  return (
    (row.command === 'clear' || row.command === 'compact') &&
    (row.state === 'completed' || row.state === 'unknown') &&
    (row.replacementSessionId === undefined ||
      (typeof row.replacementSessionId === 'string' &&
        /^[A-Za-z0-9_-]{8,128}$/.test(row.replacementSessionId))) &&
    (row.error === undefined || (typeof row.error === 'string' && row.error.length <= 4096))
  )
}

export function isAgentSessionConversationCommandRecord(
  value: unknown
): value is AgentSessionConversationCommandRecord {
  if (!isAgentSessionConversationCommandResult(value)) {
    return false
  }
  const row = value as AgentSessionConversationCommandRecord
  return (
    (row.phase === 'prepared' || row.phase === 'committed') &&
    (row.runtimeFence === undefined ||
      (Number.isSafeInteger(row.runtimeFence) && row.runtimeFence > 0)) &&
    typeof row.operationId === 'string' &&
    row.operationId.length > 0 &&
    row.operationId.length <= 512 &&
    typeof row.callerKey === 'string' &&
    row.callerKey.length > 0 &&
    row.callerKey.length <= 512
  )
}
