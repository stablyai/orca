// OSC 7501 says a program's done/error outlives its exit until the user has seen it, so the
// command-finished drop that clears a real agent's frozen Done keeps these rows instead, and the
// user's next keypress or command dismisses them. Why stateless: the row itself says it is a kept
// result, so a pane move, remount or reload cannot strand it.
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
