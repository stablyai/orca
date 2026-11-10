import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'

/** Whether the agent's tool shells miss the pane's ORCA_TERMINAL_HANDLE, so mail pointers must name the terminal. */
export function agentToolsLackTerminalHandle(agent: string | null | undefined): boolean {
  return (
    agent !== null &&
    agent !== undefined &&
    isTuiAgent(agent) &&
    TUI_AGENT_CONFIG[agent].toolsLackTerminalHandle === true
  )
}

/** Naming the terminal is right for every agent and needed by some, so any identity evidence for one
 *  counts, including an unmanaged `--command` launch whose foreground process is not read yet. */
export function ptyToolsMayLackTerminalHandle(pty: {
  launchAgent: string | null
  foregroundAgent: string | null
  launchCommandAgent: string | null
}): boolean {
  return [pty.launchAgent, pty.foregroundAgent, pty.launchCommandAgent].some((agent) =>
    agentToolsLackTerminalHandle(agent)
  )
}
