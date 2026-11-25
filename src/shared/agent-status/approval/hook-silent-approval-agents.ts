import type { AgentStatusState, AgentType } from '../contracts/agent-status-types'

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

/**
 * none: no evidence names such an agent. turn-ended: the one it names ended its own latest turn.
 * unproven: mid-turn, no report of its own, or evidence names two of them.
 */
export function hookSilentPaneSendState(
  row: { agentType?: AgentType | null; state?: AgentStatusState | null } | null | undefined,
  identities: readonly (AgentType | null | undefined)[]
): 'none' | 'turn-ended' | 'unproven' {
  const agents = new Set([row?.agentType, ...identities].filter(agentHidesApprovalsFromHooks))
  if (agents.size === 0) {
    return 'none'
  }
  const [agent] = agents
  return agents.size === 1 && row?.state === 'done' && row.agentType === agent
    ? 'turn-ended'
    : 'unproven'
}
