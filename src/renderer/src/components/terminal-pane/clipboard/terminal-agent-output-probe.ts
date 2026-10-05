import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { PaneForegroundAgentEntry } from '../../../store/slices/agent-status/pane-foreground-agent'

// Why a WeakMap keyed by the xterm instance: the clipboard paths only hold the terminal,
// and an entry must not outlive a disposed pane.
const probes = new WeakMap<object, () => boolean>()

export function setTerminalAgentOutputProbe(terminal: object, probe: () => boolean): void {
  probes.set(terminal, probe)
}

/** Whether the pane behind this terminal is known to run a TUI agent; unknown means no. */
export function terminalShowsAgentOutput(terminal: object): boolean {
  return probes.get(terminal)?.() === true
}

/** Same evidence the agent paste bracketing trusts: the live foreground agent, else a fresh status row. */
export function paneRunsTuiAgent(
  foreground: PaneForegroundAgentEntry | undefined,
  entry: AgentStatusEntry | undefined
): boolean {
  return (
    isTuiAgent(foreground?.agent) ||
    (entry?.restoredUnconfirmed !== true && isTuiAgent(entry?.agentType))
  )
}
