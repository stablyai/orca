// Resolve the closed telemetry `agent_kind` for a launch/telemetry event from a
// TuiAgent. Custom ids carry no static kind, so their base is resolved through
// the live settings catalog before mapping; unknown/unresolvable ids fall back
// to `'other'`.
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import type { AgentKind } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'
import { getAgentCatalogSettings } from './agent-catalog-settings-source'

// Kept under its original name because the store registers through it.
export { registerAgentCatalogSettingsSource as registerTelemetryAgentCatalogSource } from './agent-catalog-settings-source'

export function resolveTelemetryAgentKind(agent: TuiAgent | null | undefined): AgentKind {
  const settings = getAgentCatalogSettings()
  const baseAgent = resolveTuiAgentBaseAgent(
    agent,
    settings?.customTuiAgents,
    settings?.deletedCustomTuiAgents
  )
  // An id the catalog cannot prove is not a known harness — never label it as one.
  return baseAgent ? tuiAgentToAgentKind(baseAgent) : 'other'
}
