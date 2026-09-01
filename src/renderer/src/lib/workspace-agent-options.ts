import { mergeCustomAgentCatalogEntries } from '@/components/agent/custom-agent-catalog-entries'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../shared/types'

/** Builds the exact catalog-backed list shared by the workspace picker and its
 * selection resolver, including custom-agent readiness and base detection gates. */
export function buildWorkspaceAgentOptions({
  detectedAgentIds,
  disabledTuiAgents,
  localAgentCatalog
}: {
  detectedAgentIds: ReadonlySet<TuiAgent> | null
  disabledTuiAgents: readonly TuiAgent[]
  localAgentCatalog: LocalAgentCatalogSnapshot | null
}): AgentCatalogEntry[] {
  const enabledIds = new Set(
    filterEnabledTuiAgents(
      getAgentCatalog().map((agent) => agent.id),
      disabledTuiAgents
    )
  )
  const builtIns = getAgentCatalog().filter(
    (agent) =>
      enabledIds.has(agent.id) && (detectedAgentIds === null || detectedAgentIds.has(agent.id))
  )
  return mergeCustomAgentCatalogEntries(
    builtIns,
    localAgentCatalog,
    disabledTuiAgents,
    detectedAgentIds
  )
}
