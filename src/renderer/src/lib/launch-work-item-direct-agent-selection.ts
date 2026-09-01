import { buildWorkspaceAgentOptions } from '@/lib/workspace-agent-options'
import { DEFAULT_DISABLED_TUI_AGENTS, pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import type { GlobalSettings, TuiAgent } from '../../../shared/types'

type DirectLaunchAgentSettings =
  | Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>
  | null
  | undefined

/** Desktop-local custom-agent catalog for a direct launch. Paired web has no
 *  local catalog surface, so a rejection degrades to the built-in catalog. */
export async function loadDirectLaunchAgentCatalog(): Promise<LocalAgentCatalogSnapshot | null> {
  try {
    return await window.api.settings.agentCatalog.getLocal()
  } catch {
    return null
  }
}

/**
 * Resolve the agent identity a direct "Use" launch requests, validated against
 * the full catalog (built-ins plus ready custom agents) exactly like the
 * composer picker. Custom ids never appear in base detection, so gating on
 * detection alone rejects a custom override and silently downgrades a custom
 * default to a built-in.
 */
export function resolveDirectLaunchAgent({
  agentOverride,
  detectedAgents,
  localAgentCatalog,
  settings
}: {
  agentOverride?: TuiAgent
  detectedAgents: readonly TuiAgent[]
  localAgentCatalog: LocalAgentCatalogSnapshot | null
  settings: DirectLaunchAgentSettings
}): { requestedAgent: TuiAgent | null; agentOverrideUnavailable: boolean } {
  const selectableAgentIds = new Set(
    buildWorkspaceAgentOptions({
      detectedAgentIds: new Set(detectedAgents),
      disabledTuiAgents: settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS,
      localAgentCatalog
    }).map((entry) => entry.id)
  )
  if (agentOverride) {
    const overrideUsable = selectableAgentIds.has(agentOverride)
    return {
      requestedAgent: overrideUsable ? agentOverride : null,
      agentOverrideUnavailable: !overrideUsable
    }
  }
  return {
    requestedAgent: pickTuiAgent(
      settings?.defaultTuiAgent,
      selectableAgentIds,
      settings?.disabledTuiAgents
    ),
    agentOverrideUnavailable: false
  }
}
