export const AGENT_SESSION_DISPATCH_LIMITS = { claude: 64, codex: 256 } as const
export type AgentSessionReceiptProvider = keyof typeof AGENT_SESSION_DISPATCH_LIMITS

export function isAgentSessionReceiptProvider(
  provider: string
): provider is AgentSessionReceiptProvider {
  return provider === 'claude' || provider === 'codex'
}
