import type { AgentExecutionRuntime } from './detected-agent-executables'
import { getDetectedTuiAgentExecutable } from './detected-agent-executables'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

/**
 * Rewrites the leading executable of an agent CLI command to the form the
 * detected install actually provides (`cursor-agent models` → `cursor agent
 * models`). Returns `command` unchanged when detection matched `detectCmd`,
 * when the agent has no alias mapping, when nothing has been detected yet, or
 * when `runtime` points at a host this process never detected (SSH, WSL).
 */
export function applyDetectedTuiAgentExecutable(
  agent: TuiAgent,
  command: string,
  runtime?: AgentExecutionRuntime
): string {
  const config = TUI_AGENT_CONFIG[agent]
  const detectedCmd = getDetectedTuiAgentExecutable(agent, runtime)
  const launchCmd = detectedCmd ? config.launchCmdByDetectCmd?.[detectedCmd] : undefined
  if (!launchCmd) {
    return command
  }
  if (command === config.launchCmd) {
    return launchCmd
  }
  return command.startsWith(`${config.launchCmd} `)
    ? `${launchCmd}${command.slice(config.launchCmd.length)}`
    : command
}
