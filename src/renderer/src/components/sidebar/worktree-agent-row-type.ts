import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { resolveAgentTypeFromTerminalTitle } from './worktree-title-derived-agent-rows'

/**
 * Resolves the sidebar row agent type, prioritizing launch agent configuration
 * and normalizing compatible agent kinds.
 */
export function resolveRowAgentType(entry: AgentStatusEntry, tab?: TerminalTab | null): AgentType {
  const launchOwner = { ownerIsLaunch: Boolean(tab?.launchAgent) }
  const entryAgentType = resolveCompatibleAgentTypeForOwner(
    entry.agentType,
    tab?.launchAgent,
    launchOwner
  )
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return (
    resolveAgentTypeFromTerminalTitle(
      entry.terminalTitle ?? tab?.title,
      tab?.launchAgent,
      launchOwner
    ) ??
    tab?.launchAgent ??
    entryAgentType ??
    'unknown'
  )
}
