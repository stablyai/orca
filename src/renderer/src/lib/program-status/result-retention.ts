// OSC 7501 done/error survives program exit until user input, unlike agents’ frozen Done. Derive retention from the row so moves/remounts/reloads cannot strand results.
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isRetainedProgramResult } from '@/lib/program-status/row'

// Why the state parameter: callers outside React read the store directly; this module must not import it.
export function dismissRetainedProgramResult(
  paneKey: string,
  state: {
    agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry | undefined>>
    dropAgentStatus: (paneKey: string) => void
  }
): void {
  const current = state.agentStatusByPaneKey[paneKey]
  if (current && isRetainedProgramResult(current)) {
    state.dropAgentStatus(paneKey)
  }
}
