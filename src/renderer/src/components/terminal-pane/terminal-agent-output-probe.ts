import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'

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

/** The live foreground agent, else a fresh status row unless the foreground is proven to be the shell. */
export function paneRunsTuiAgent(
  foreground: PaneForegroundAgentEntry | undefined,
  entry: AgentStatusEntry | undefined
): boolean {
  if (isTuiAgent(foreground?.agent)) {
    return true
  }
  // Why veto here but not in paste bracketing: a latched shell flag only costs the old
  // unjoined copy, while a stale status row would rewrite copied shell output.
  if (foreground?.shellForeground === true) {
    return false
  }
  return entry?.restoredUnconfirmed !== true && isTuiAgent(entry?.agentType)
}
