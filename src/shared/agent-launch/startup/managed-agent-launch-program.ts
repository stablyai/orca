import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  buildShellCommandFromArgv,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Full paths to Orca's copies, reported by a host only for agents it has no CLI of its own for. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

/** Runs Orca's copy by full path where `command` starts with the agent's stock program; the
 *  user's own CLI (none reported) and a Command setting keep `command` as written. */
export function withManagedAgentProgram(
  command: string,
  args: {
    agent: TuiAgent
    cmdOverrides: Partial<Record<TuiAgent, string>>
    managedAgentCommands?: ManagedAgentCommands | null
    platform: NodeJS.Platform
    shell: AgentStartupShell
    isRemote?: boolean
  }
): string {
  const path = args.managedAgentCommands?.[args.agent]
  if (!path || args.cmdOverrides[args.agent]?.trim()) {
    return command
  }
  const stock = tokenizeStartupCommand(
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    }),
    args.shell
  )
  const tokens = tokenizeStartupCommand(command, args.shell)
  if (!stock.ok || !tokens.ok || !tokens.tokens.length || tokens.tokens[0] !== stock.tokens[0]) {
    return command
  }
  return buildShellCommandFromArgv([path], args.shell) + command.slice(tokens.spans[0].end)
}
