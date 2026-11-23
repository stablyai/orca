import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import { readLaunchArguments, readLaunchPosition, type LaunchPosition } from './launch-position'
import { clearEnvCommand, quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

/** Full paths to Orca's copies, reported by a host only for agents it has no CLI of its own for. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

/** A program as the head of a launch, through the call operator for PowerShell. */
export function launchProgramHead(path: string, shell: AgentStartupShell): string {
  const quoted = quoteLaunchProgram(path, shell)
  return shell === 'powershell' && quoted !== path ? `& ${quoted}` : quoted
}

/** A program path as one word: a plain name reads alike in every shell. */
function quoteLaunchProgram(path: string, shell: AgentStartupShell): string {
  if (/^[\w.-]+$/.test(path)) {
    return path
  }
  return shell === 'cmd' ? quoteWindowsCmdArgument(path) : quoteStartupArg(path, shell)
}

export function renderLaunchInvocation(
  executable: string,
  argv: readonly string[],
  shell: AgentStartupShell
): string {
  return [
    launchProgramHead(executable, shell),
    ...argv.map((arg) => quoteStartupArg(arg, shell))
  ].join(' ')
}

export function replaceLaunchExecutable(
  command: string,
  shell: AgentStartupShell,
  launch: LaunchPosition,
  executable: string
): string {
  if (executable === launch.executable) {
    return command
  }
  const head = launch.hasCallOperator
    ? quoteLaunchProgram(executable, shell)
    : launchProgramHead(executable, shell)
  return command.slice(0, launch.start) + head + command.slice(launch.end)
}

/** The Windows setup gate evaluates its carried launch in PowerShell, including from cmd panes. */
export function renderCmdLaunchForPowerShell(
  command: string,
  launch: LaunchPosition,
  executable: string
): string | null {
  const args = readLaunchArguments(command, 'cmd', launch)
  if (!args || args.includes('--%')) {
    return null
  }
  const statements = [...launch.env].map(([name, value]) =>
    value === undefined
      ? clearEnvCommand(name, 'powershell')
      : `$env:${name}=${quoteStartupArg(value, 'powershell')}`
  )
  if (launch.cwd) {
    statements.push(`Set-Location -LiteralPath ${quoteStartupArg(launch.cwd, 'powershell')}`)
  }
  statements.push(renderLaunchInvocation(executable, args, 'powershell'))
  return statements.join('; ')
}

export function stockLaunchProgram(
  agent: TuiAgent,
  platform: NodeJS.Platform,
  isRemote?: boolean
): string {
  return getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], platform, { isRemote }).split(' ')[0]
}

/** A program name as that platform's lookup sees it: Windows ignores case and an .exe/.cmd/.bat extension. */
export function stockProgramKey(program: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? program.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') : program
}

export function withManagedAgentProgram(
  command: string,
  args: {
    agent: TuiAgent
    managedAgentCommands?: ManagedAgentCommands | null
    platform: NodeJS.Platform
    shell: AgentStartupShell
    isRemote?: boolean
  }
): string {
  const path = args.managedAgentCommands?.[args.agent]
  if (!path) {
    return command
  }
  const launch = readLaunchPosition(command, args.shell)
  return launch &&
    stockProgramKey(launch.executable, args.platform) ===
      stockProgramKey(stockLaunchProgram(args.agent, args.platform, args.isRemote), args.platform)
    ? replaceLaunchExecutable(command, args.shell, launch, path)
    : command
}
