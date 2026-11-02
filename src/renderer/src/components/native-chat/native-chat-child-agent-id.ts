export function nativeChatChildAgentId(agentId: string): string {
  return agentId.startsWith('codex-agent:') && agentId.length > 'codex-agent:'.length
    ? agentId.slice('codex-agent:'.length)
    : agentId
}
