import type { AgentType } from './agent-status-types'

export type AgentImageHandling = 'attachment' | 'unsupported'

const IMAGE_ATTACHMENT_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>([
  'claude',
  'openclaude',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'droid',
  // Why: Grok CLI turns bracket-pasted image paths into image chips.
  'grok'
])

export function getAgentImageHandling(agent: AgentType): AgentImageHandling {
  return IMAGE_ATTACHMENT_AGENTS.has(agent) ? 'attachment' : 'unsupported'
}
