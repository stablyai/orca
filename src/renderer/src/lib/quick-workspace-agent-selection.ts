import type { TuiAgent } from '../../../shared/types'
import type { AgentId } from '../../../shared/custom-agent'
import {
  customAgentForId,
  isCustomAgentId,
  type CustomAgentDefinition
} from '../../../shared/custom-agent'
import {
  isTuiAgentEnabled,
  pickTuiAgent,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../shared/tui-agent-selection'

export function pickQuickWorkspaceAgent(
  preferred: AgentId | 'blank' | null | undefined,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null,
  customAgents?: readonly CustomAgentDefinition[]
): AgentId | null {
  if (
    preferred &&
    preferred !== 'blank' &&
    isCustomAgentId(preferred) &&
    isTuiAgentEnabled(preferred, disabledTuiAgents) &&
    customAgentForId(preferred, customAgents)?.enabled === true
  ) {
    return preferred
  }
  const candidates = detectedAgentIds ?? TUI_AGENT_AUTO_PICK_ORDER
  return pickTuiAgent(
    preferred && !isCustomAgentId(preferred) ? preferred : null,
    candidates,
    disabledTuiAgents
  )
}

function hasDetectedAgent(detectedAgentIds: Iterable<TuiAgent>, agent: TuiAgent): boolean {
  if (detectedAgentIds instanceof Set) {
    return detectedAgentIds.has(agent)
  }
  for (const detectedAgentId of detectedAgentIds) {
    if (detectedAgentId === agent) {
      return true
    }
  }
  return false
}

function isQuickWorkspaceAgentAvailable(
  agent: AgentId,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null,
  customAgents?: readonly CustomAgentDefinition[]
): boolean {
  if (!isTuiAgentEnabled(agent, disabledTuiAgents)) {
    return false
  }
  return (
    (isCustomAgentId(agent) && customAgentForId(agent, customAgents)?.enabled === true) ||
    (!isCustomAgentId(agent) &&
      (detectedAgentIds === null || hasDetectedAgent(detectedAgentIds, agent as TuiAgent)))
  )
}

export function resolveQuickWorkspaceAgentSelection({
  quickAgentOverride,
  preferredQuickAgent,
  detectedAgentIds,
  disabledTuiAgents,
  customAgents
}: {
  quickAgentOverride: AgentId | null | undefined
  preferredQuickAgent: AgentId | null
  detectedAgentIds: Iterable<TuiAgent> | null
  disabledTuiAgents?: Iterable<unknown> | null
  customAgents?: readonly CustomAgentDefinition[]
}): {
  quickAgent: AgentId | null
  quickAgentOverride: AgentId | null | undefined
} {
  if (quickAgentOverride === undefined || quickAgentOverride === null) {
    return {
      quickAgent: quickAgentOverride === undefined ? preferredQuickAgent : null,
      quickAgentOverride
    }
  }
  if (
    isQuickWorkspaceAgentAvailable(
      quickAgentOverride,
      detectedAgentIds,
      disabledTuiAgents,
      customAgents
    )
  ) {
    return { quickAgent: quickAgentOverride, quickAgentOverride }
  }
  return { quickAgent: preferredQuickAgent, quickAgentOverride: preferredQuickAgent }
}
