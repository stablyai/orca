import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { AGENT_HOOK_CONFIG_LOCATIONS } from '../../../../shared/agent-hook-config-locations'
import { AGENT_HOOK_TARGETS, type AgentHookTarget } from '../../../../shared/agent-hook-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents
} from '../../../../shared/tui-agent-selection'

export type AgentStatusHookAffectedRow = {
  agent: AgentHookTarget
  name: string
  location: string
}

/** The agents a managed-hook install would actually write for, in catalog display order. */
export function buildAgentStatusHookAffectedRows(input: {
  detectedAgentIds: Iterable<TuiAgent>
  disabledTuiAgents: unknown
}): AgentStatusHookAffectedRow[] {
  const detected = new Set(input.detectedAgentIds)
  const disabled = normalizeDisabledTuiAgents(input.disabledTuiAgents)
  const catalog = getAgentCatalog()
  const rows: AgentStatusHookAffectedRow[] = []
  // Why AGENT_HOOK_TARGETS and not the detection order: detection resolves concurrently, so its
  // order is not stable between renders.
  for (const agent of AGENT_HOOK_TARGETS) {
    if (!detected.has(agent) || !isTuiAgentEnabled(agent, disabled)) {
      continue
    }
    rows.push({
      agent,
      name: catalog.find((entry) => entry.id === agent)?.label ?? agent,
      location:
        AGENT_HOOK_CONFIG_LOCATIONS[agent] ??
        translate(
          'auto.components.onboarding.agent-status-hook-disclosure-rows.codexLocation',
          'Orca-managed Codex home'
        )
    })
  }
  return rows
}
