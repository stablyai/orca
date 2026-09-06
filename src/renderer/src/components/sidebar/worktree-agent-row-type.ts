import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveCanonicalPaneAgentIdentity } from '../../../../shared/pane-agent-identity-adapter'
import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'
import { agentTypeToIconAgent } from '@/lib/agent-status'

/**
 * Resolves the sidebar row agent type, prioritizing launch agent configuration
 * and normalizing compatible agent kinds.
 */
export function resolveRowAgentType(entry: AgentStatusEntry, tab?: TerminalTab | null): AgentType {
  const entryAgent = agentTypeToIconAgent(entry.agentType)
  const title = entry.terminalTitle ?? tab?.title
  const canonical = resolveCanonicalPaneAgentIdentity({
    hookAgent: entry.state === 'done' ? null : entryAgent,
    hookIsLive: true,
    completedHookAgent: entry.state === 'done' ? entryAgent : null,
    launchAgent: tab?.launchAgent ?? null,
    title,
    uncoveredFallback: {
      agent: title ? resolveExplicitTerminalTitleAgentType(title) : null,
      titleOnly: true
    }
  })
  return canonical.agent ?? tab?.launchAgent ?? entry.agentType ?? 'unknown'
}
