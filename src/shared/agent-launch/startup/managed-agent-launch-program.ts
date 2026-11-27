import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'
import type { SleepingAgentLaunchConfig } from '../../agent-session/lifecycle/resume/sleeping-agent-launch-config'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import { readLaunchArguments, type LaunchPosition } from './launch-position'
import { clearEnvCommand, quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

/** Full paths to user-installed CLIs the terminal can't launch by name. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

/** A program as the head of a launch, through the call operator for PowerShell. */
export function launchProgramHead(path: string, shell: AgentStartupShell): string {
  const quoted = quoteLaunchProgram(path, shell)
  return shell === 'powershell' && quoted !== path ? `& ${quoted}` : quoted
}

export function savedLaunchProgramHead(
  path: string,
  shell: AgentStartupShell,
  suffix = ''
): string {
  return shell !== 'posix' &&
    /^[A-Za-z]:\\[\w.\\-]+$/.test(path) &&
    /^[\w ./:=\\+\t-]*$/.test(suffix)
    ? path
    : launchProgramHead(path, shell)
}

export function renderPinnedLaunchHead(
  command: string,
  pin: string,
  shell: AgentStartupShell
): string {
  const rendered = launchProgramHead(pin, shell)
  for (const source of ['powershell', 'cmd', 'posix'] satisfies AgentStartupShell[]) {
    const head = launchProgramHead(pin, source)
    const suffix = command.slice(head.length)
    if (command.startsWith(head) && (!suffix || /^\s/.test(suffix))) {
      const argv =
        source === shell ? null : readLaunchArguments(command, source, { end: head.length })
      return argv ? renderLaunchInvocation(pin, argv, shell) : rendered + suffix
    }
  }
  const portableHead = savedLaunchProgramHead(pin, 'cmd')
  const suffix = command.slice(portableHead.length)
  if (command.startsWith(portableHead) && (!suffix || /^\s/.test(suffix))) {
    return rendered + suffix
  }
  return command
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

export function saveGeneratedLaunchProgram(
  config: SleepingAgentLaunchConfig,
  shell: AgentStartupShell,
  command: string | undefined,
  launch: LaunchPosition | null,
  head: string | undefined,
  path: string | undefined
): SleepingAgentLaunchConfig {
  const { selectedExecutable: _previous, ...recipe } = config
  return {
    ...recipe,
    ...(head && launch && command
      ? {
          agentCommand: /^[ \t]*(?:&[ \t]+)?$/.test(command.slice(0, launch.start))
            ? savedLaunchProgramHead(head, shell, command.slice(launch.end)) +
              command.slice(launch.end)
            : replaceLaunchExecutable(command, shell, launch, head)
        }
      : {}),
    commandProvenance: 'generated',
    ...(path ? { selectedExecutable: path } : {})
  }
}

/** The Windows setup gate evaluates its carried launch in PowerShell, including from cmd panes. */
export function renderCmdLaunchForPowerShell(
  command: string,
  launch: Pick<LaunchPosition, 'end' | 'cwd' | 'env'>,
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
    statements.push(
      `Set-Location -LiteralPath ${quoteStartupArg(launch.cwd, 'powershell')} -ErrorAction Stop`
    )
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

/** A stock agent's identity, independent of its executable's Windows spelling. */
export function stockProgramKey(program: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? program.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') : program
}

export function matchesStockLaunchProgram(
  program: string | undefined,
  stock: string,
  platform: NodeJS.Platform
): boolean {
  return platform === 'win32' ? program?.toLowerCase() === stock.toLowerCase() : program === stock
}

export function launchCommandProvenance(
  override: string | undefined,
  stock: string,
  platform: NodeJS.Platform
): 'authored' | 'generated' {
  const command = override?.trim()
  return !command || matchesStockLaunchProgram(command, stock, platform) ? 'generated' : 'authored'
}

export function withManagedAgentProgram(
  command: string,
  args: {
    agent: TuiAgent
    cmdOverrides?: Partial<Record<TuiAgent, string | undefined>>
    managedAgentCommands?: ManagedAgentCommands | null
    platform: NodeJS.Platform
    shell: AgentStartupShell
    isRemote?: boolean
  }
): string {
  const path = args.managedAgentCommands?.[args.agent]
  const stock = stockLaunchProgram(args.agent, args.platform, args.isRemote)
  if (!path) {
    return command
  }
  if (
    launchCommandProvenance(args.cmdOverrides?.[args.agent], stock, args.platform) === 'authored'
  ) {
    return command
  }
  // These builders only substitute the stock head. The host parses saved shell prefixes.
  const head = /^([ \t]*)([\w.-]+)(?=$|[ \t])/.exec(command)
  return head && matchesStockLaunchProgram(head[2], stock, args.platform) && path !== head[2]
    ? head[1] + launchProgramHead(path, args.shell) + command.slice(head[0].length)
    : command
}
