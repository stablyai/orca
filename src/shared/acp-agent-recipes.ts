/** Agents whose Native Chat composer is an ACP stdio child. */

export const ACP_STRUCTURED_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'cursor'] as const

export type AcpStructuredAgent = (typeof ACP_STRUCTURED_AGENTS)[number]

export type AcpSpawnRecipe = {
  program: string
  args: readonly string[]
}

export function isAcpStructuredAgent(
  agent: string | null | undefined
): agent is AcpStructuredAgent {
  return agent != null && (ACP_STRUCTURED_AGENTS as readonly string[]).includes(agent)
}

export function acpHandleProvider(agent: string): 'claude' | 'codex' | 'grok' | 'cursor' | null {
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'codex' || agent === 'grok' || agent === 'cursor') {
    return agent
  }
  return null
}

export function acpAccountHomeVariable(
  agent: string
): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'GROK_HOME' | 'CURSOR_CONFIG_DIR' | null {
  const provider = acpHandleProvider(agent)
  if (provider === 'claude') {
    return 'CLAUDE_CONFIG_DIR'
  }
  if (provider === 'codex') {
    return 'CODEX_HOME'
  }
  if (provider === 'grok') {
    return 'GROK_HOME'
  }
  if (provider === 'cursor') {
    return 'CURSOR_CONFIG_DIR'
  }
  return null
}

export function acpSpawnRecipe(agent: string): AcpSpawnRecipe | null {
  switch (agent) {
    case 'grok':
      return { program: 'grok', args: ['agent', 'stdio'] }
    case 'cursor':
      return { program: 'agent', args: ['acp'] }
    case 'claude':
    case 'openclaude':
      return { program: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] }
    case 'codex':
      return { program: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] }
    default:
      return null
  }
}
