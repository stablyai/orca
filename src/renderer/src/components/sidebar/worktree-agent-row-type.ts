import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import type { TerminalTab } from '../../../../shared/types'
import { resolveAgentTypeFromTerminalTitle } from './worktree-title-derived-agent-rows'

/** Resolves a sidebar row's provider from hook, title, and launch evidence. */
export function resolveWorktreeAgentRowType(
  entry: AgentStatusEntry,
  tab?: TerminalTab | null
): AgentType {
  const entryAgentType = resolveCompatibleAgentTypeForOwner(entry.agentType, tab?.launchAgent)
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return (
    resolveAgentTypeFromTerminalTitle(entry.terminalTitle ?? tab?.title, tab?.launchAgent) ??
    tab?.launchAgent ??
    entryAgentType ??
    'unknown'
  )
}
