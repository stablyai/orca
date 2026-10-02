import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'

export function mergeNativeChatSessionContext(
  current: AgentSessionContextSnapshot,
  incoming: AgentSessionContextSnapshot
): AgentSessionContextSnapshot {
  const waiting = current.compaction === 'requested' || current.compaction === 'running'
  const compacted =
    waiting &&
    current.usedTokens !== null &&
    incoming.usedTokens !== null &&
    incoming.usedTokens < current.usedTokens
  if (compacted) {
    return { ...incoming, compaction: 'completed', compactionUpdatedAt: Date.now() }
  }
  if (waiting && incoming.compaction === 'idle') {
    return {
      ...incoming,
      compaction: current.compaction,
      compactionUpdatedAt: current.compactionUpdatedAt
    }
  }
  return incoming
}
