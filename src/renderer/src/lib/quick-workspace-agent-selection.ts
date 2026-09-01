import type { TuiAgent } from '../../../shared/types'
import { pickTuiAgent, TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

export function pickQuickWorkspaceAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  selectableAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null
): TuiAgent | null {
  const candidates = selectableAgentIds ?? TUI_AGENT_AUTO_PICK_ORDER
  return pickTuiAgent(preferred, candidates, disabledTuiAgents)
}

function hasSelectableAgent(selectableAgentIds: Iterable<TuiAgent>, agent: TuiAgent): boolean {
  if (selectableAgentIds instanceof Set) {
    return selectableAgentIds.has(agent)
  }
  for (const selectableAgentId of selectableAgentIds) {
    if (selectableAgentId === agent) {
      return true
    }
  }
  return false
}

function isQuickWorkspaceAgentAvailable(
  agent: TuiAgent,
  selectableAgentIds: Iterable<TuiAgent> | null
): boolean {
  return selectableAgentIds === null || hasSelectableAgent(selectableAgentIds, agent)
}

export function resolveQuickWorkspaceAgentSelection({
  quickAgentOverride,
  preferredQuickAgent,
  selectableAgentIds
}: {
  quickAgentOverride: TuiAgent | null | undefined
  preferredQuickAgent: TuiAgent | null
  selectableAgentIds: Iterable<TuiAgent> | null
}): {
  quickAgent: TuiAgent | null
  quickAgentOverride: TuiAgent | null | undefined
} {
  if (quickAgentOverride === undefined || quickAgentOverride === null) {
    return {
      quickAgent: quickAgentOverride === undefined ? preferredQuickAgent : null,
      quickAgentOverride
    }
  }
  if (isQuickWorkspaceAgentAvailable(quickAgentOverride, selectableAgentIds)) {
    return { quickAgent: quickAgentOverride, quickAgentOverride }
  }
  return { quickAgent: preferredQuickAgent, quickAgentOverride: preferredQuickAgent }
}
