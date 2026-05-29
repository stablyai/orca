import type { TuiAgent } from '../../../shared/types'
import { pickTuiAgent, TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

export function pickQuickWorkspaceAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null
): TuiAgent | null {
  const candidates = detectedAgentIds ?? TUI_AGENT_AUTO_PICK_ORDER
  return pickTuiAgent(preferred, candidates, disabledTuiAgents)
}
