import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'
import { isClaudeAgent } from '../../../../../shared/agent-status/title/agent-title-identity'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { PromptCacheTimerEntry } from '@/store/terminals/terminal-state'
import type { AgentIdleEdgeMeta } from '../../../../../shared/terminal/output/terminal-output-side-effects'

/** Claude owns the edge: its title says so, or its status row does once the title drops its glyph. */
function isClaudeIdleEdge(
  title: string,
  entry: Pick<AgentStatusEntry, 'agentType'> | undefined
): boolean {
  return isClaudeAgent(title) || entry?.agentType === 'claude'
}

/** An idle title alone is not a request; only a pane with request evidence holds a provider cache. */
export function canStartPromptCacheCountdown(args: {
  title: string
  entry: Pick<AgentStatusEntry, 'agentType'> | undefined
  settings: { promptCacheTimerEnabled: boolean } | null
  startedAt: PromptCacheTimerEntry | undefined
}): boolean {
  const { title, entry, settings, startedAt } = args
  // Null settings means not hydrated yet; a dropped start loses the countdown, a spurious one is harmless.
  return (
    startedAt !== undefined &&
    isClaudeIdleEdge(title, entry) &&
    (settings === null || settings.promptCacheTimerEnabled)
  )
}

/** The agent settled at rest, not on a prompt; the title decides only for edges from older hosts. */
export function idleEdgeSettledAtRest(title: string, meta: AgentIdleEdgeMeta | undefined): boolean {
  return (meta?.status ?? detectAgentStatusFromTitle(title)) === 'idle'
}
