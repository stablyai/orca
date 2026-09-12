import type { AgentMapStatusCounts } from './agent-map-node-metadata'

export type AgentMapWorktreeActiveStatus = 'blocked' | 'waiting' | 'working' | 'done'

/**
 * Most urgent first. `done` ranks last on purpose: a workspace with anything still
 * running is a working workspace, even if a sibling agent already finished — the ring
 * only turns green once the whole workspace has settled and a finish is still unread.
 * `done-seen` never lights the ring, matching the node treatment where acknowledging a
 * finish is what releases the attention.
 */
export function agentMapWorktreeActiveStatus(
  counts: AgentMapStatusCounts
): AgentMapWorktreeActiveStatus | null {
  if (counts.blocked > 0) {
    return 'blocked'
  }
  if (counts.waiting > 0) {
    return 'waiting'
  }
  if (counts.working > 0) {
    return 'working'
  }
  return counts.done > 0 ? 'done' : null
}
