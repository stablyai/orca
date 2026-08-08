import type { AgentType } from './agent-status-types'

export const AGENT_COMPACT_COMMAND = '/compact'

export const COMPACTABLE_AGENT_TYPES = ['claude', 'openclaude', 'codex', 'grok'] as const

export type CompactableAgentType = (typeof COMPACTABLE_AGENT_TYPES)[number]

export function isAgentCompactionSupported(
  agent: AgentType | null | undefined
): agent is CompactableAgentType {
  return COMPACTABLE_AGENT_TYPES.includes(agent as CompactableAgentType)
}
