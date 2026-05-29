import { isCustomTuiAgentId } from '../../../shared/effective-tui-agent'
import type { TuiAgent, TuiAgentId } from '../../../shared/types'
import { pickTuiAgent, TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

export function pickQuickWorkspaceAgent(
  preferred: TuiAgentId | 'blank' | null | undefined,
  detectedAgentIds: Iterable<TuiAgentId> | null,
  disabledTuiAgents?: Iterable<unknown> | null
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const candidates = detectedAgentIds
    ? ([...detectedAgentIds].filter((id) => !isCustomTuiAgentId(id)) as TuiAgent[])
    : TUI_AGENT_AUTO_PICK_ORDER
  const preferredBuiltIn = preferred && !isCustomTuiAgentId(preferred) ? preferred : null
  return pickTuiAgent(preferredBuiltIn, candidates, disabledTuiAgents)
}
