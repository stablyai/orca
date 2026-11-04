import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { SubagentDisplayMode } from '../../../../shared/ui-chrome-types'

export function prepareWorktreeCardAgents(
  agents: readonly DashboardAgentRow[],
  options: { showSubagents: boolean; subagentDisplayMode: SubagentDisplayMode }
): DashboardAgentRow[] {
  if (!options.showSubagents) {
    return agents.filter((agent) => agent.rowSource !== 'subagent')
  }
  if (options.subagentDisplayMode === 'flat') {
    return agents.map((agent) => {
      if (agent.rowSource !== 'subagent') {
        return agent
      }
      const { lineage: _lineage, entry, ...flatAgent } = agent
      const { orchestration: _orchestration, ...flatEntry } = entry
      return { ...flatAgent, entry: flatEntry }
    })
  }
  return [...agents]
}
