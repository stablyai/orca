import type { AgentMapStatusCounts } from './agent-map-layout'

export type AgentMapWorktreeActiveStatus = 'blocked' | 'waiting' | 'working'

export function agentMapWorktreeActiveStatus(
  counts: AgentMapStatusCounts
): AgentMapWorktreeActiveStatus | null {
  if (counts.blocked > 0) {
    return 'blocked'
  }
  if (counts.waiting > 0) {
    return 'waiting'
  }
  return counts.working > 0 ? 'working' : null
}
