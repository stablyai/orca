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
