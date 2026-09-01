import { customAgentCatalogEntryById } from '@/components/agent/custom-agent-catalog-entries'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { buildWorkspaceAgentOptions } from '@/lib/workspace-agent-options'
import { DEFAULT_DISABLED_TUI_AGENTS } from '../../../../shared/tui-agent-selection'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../../shared/types'

/** Agent rows the source-control action picker offers: the same catalog-backed
 *  list as the workspace composer, so named custom agents — which never appear
 *  in base detection — are selectable here too. A saved-but-unavailable
 *  selection stays listed with its real label instead of vanishing. */
export function buildSourceControlAgentActionOptions({
  enabledDetectedAgents,
  disabledAgents,
  localAgentCatalog,
  selectedAgent
}: {
  enabledDetectedAgents: readonly TuiAgent[]
  disabledAgents: readonly TuiAgent[] | undefined
  localAgentCatalog: LocalAgentCatalogSnapshot | null
  selectedAgent: TuiAgent | null
}): AgentCatalogEntry[] {
  const options = buildWorkspaceAgentOptions({
    detectedAgentIds: new Set(enabledDetectedAgents),
    disabledTuiAgents: disabledAgents ?? DEFAULT_DISABLED_TUI_AGENTS,
    localAgentCatalog
  })
  if (!selectedAgent || options.some((entry) => entry.id === selectedAgent)) {
    return options
  }
  const selectedEntry =
    getAgentCatalog().find((entry) => entry.id === selectedAgent) ??
    customAgentCatalogEntryById(localAgentCatalog, selectedAgent)
  return selectedEntry ? [...options, selectedEntry] : options
}
