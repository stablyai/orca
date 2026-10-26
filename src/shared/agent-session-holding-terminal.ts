export type AgentSessionHoldingTerminal = {
  paneKey: string
  worktreeId: string
  incarnationId?: string
}

export function readAgentSessionHoldingTerminal(
  value: unknown
): AgentSessionHoldingTerminal | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'paneKey' in value &&
    'worktreeId' in value &&
    typeof value.paneKey === 'string' &&
    value.paneKey.trim() &&
    value.paneKey.length <= 512 &&
    !value.paneKey.includes('\0') &&
    typeof value.worktreeId === 'string' &&
    value.worktreeId.trim() &&
    value.worktreeId.length <= 4096 &&
    !value.worktreeId.includes('\0')
    ? {
        paneKey: value.paneKey,
        worktreeId: value.worktreeId,
        ...('incarnationId' in value &&
        typeof value.incarnationId === 'string' &&
        value.incarnationId.length > 0 &&
        value.incarnationId.length <= 256 &&
        !value.incarnationId.includes('\0')
          ? { incarnationId: value.incarnationId }
          : {})
      }
    : undefined
}

export function readAgentSessionRefusalHoldingTerminal(
  code: string,
  value: Record<string, unknown>
): AgentSessionHoldingTerminal | undefined {
  return !value.owner &&
    ((code === 'agent_session_conflict' && value.reason === 'conversationHeldElsewhere') ||
      (code === 'agent_session_operation_invalid' && value.reason === 'conversationOpenInTerminal'))
    ? readAgentSessionHoldingTerminal(value.terminal)
    : undefined
}
