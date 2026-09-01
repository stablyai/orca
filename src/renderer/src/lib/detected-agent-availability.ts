import { getAgentCatalogSettings } from '@/lib/agent-catalog-settings-source'
import { isCustomTuiAgentId, resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/types'

/** Whether a launch surface may run `agent` on a host with `detectedAgents`.
 *
 *  Host detection probes built-in harness binaries only, so a custom id is never
 *  a member of that list: a baseline-stock custom stands on its base harness's
 *  detection, and one carrying its own executable is launch-reported (only the launch itself checks it)
 *  and never client-gated (oracle 35). Without this, every custom assignment
 *  reads as "not available on this host" and its surface refuses to launch. */
export function isDetectedAgentAvailable(
  agent: TuiAgent,
  detectedAgents: readonly TuiAgent[],
  disabledAgents?: readonly TuiAgent[]
): boolean {
  if (!isTuiAgentEnabled(agent, disabledAgents)) {
    return false
  }
  if (!isCustomTuiAgentId(agent)) {
    return detectedAgents.includes(agent)
  }
  const catalogSettings = getAgentCatalogSettings()
  const definition = catalogSettings?.customTuiAgents?.find((candidate) => candidate?.id === agent)
  if (!definition) {
    return false
  }
  if (definition.commandOverride?.trim()) {
    return true
  }
  const base = resolveTuiAgentBaseAgent(
    agent,
    catalogSettings?.customTuiAgents,
    catalogSettings?.deletedCustomTuiAgents
  )
  return base !== null && detectedAgents.includes(base) && isTuiAgentEnabled(base, disabledAgents)
}
