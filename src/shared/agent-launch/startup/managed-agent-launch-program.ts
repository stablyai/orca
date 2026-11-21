import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  buildShellCommandFromArgv,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Full paths to Orca's copies, reported by a host only for agents it has no CLI of its own for. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

/** A program as the head of a launch: a path in plain double quotes for cmd (carets inside quotes
 *  stay literal), through its call operator for PowerShell. */
export function launchProgramHead(path: string, shell: AgentStartupShell): string {
  // A plain name reads alike in every shell.
  if (/^[\w.-]+$/.test(path)) {
    return path
  }
  return shell === 'cmd' ? `"${path}"` : buildShellCommandFromArgv([path], shell)
}

/** Swaps the program `command` launches for what `replace` names; unchanged when it names none. */
export function replaceLaunchProgram(
  command: string,
  shell: AgentStartupShell,
  replace: (program: string) => string | null
): string {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return command
  }
  // PowerShell runs a quoted path through its call operator, which the head is rebuilt with.
  const head = shell === 'powershell' && parsed.tokens[0] === '&' ? 1 : 0
  const program = parsed.tokens[head]
  const next = program === undefined ? null : replace(program)
  return next && next !== program
    ? command.slice(0, parsed.spans[0].start) +
        launchProgramHead(next, shell) +
        command.slice(parsed.spans[head].end)
    : command
}

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
  return stock.ok
    ? replaceLaunchProgram(command, args.shell, (program) =>
        program === stock.tokens[0] ? path : null
      )
    : command
}
