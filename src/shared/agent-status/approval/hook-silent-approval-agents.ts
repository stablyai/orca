import type { AgentType } from '../contracts/agent-status-types'

// Their hooks keep reporting working while an approval menu waits for a key, so a pasted Enter could answer it.
const HOOK_SILENT_APPROVAL_AGENTS: ReadonlySet<AgentType> = new Set([
  'amp',
  'command-code',
  'cursor',
  'kiro'
])

export function agentHidesApprovalsFromHooks(
  agentType: AgentType | null | undefined
): agentType is AgentType {
  return agentType != null && HOOK_SILENT_APPROVAL_AGENTS.has(agentType)
}
