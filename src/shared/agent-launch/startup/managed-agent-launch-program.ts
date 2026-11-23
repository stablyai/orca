import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Full paths to Orca's copies, reported by a host only for agents it has no CLI of its own for. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

/** A program as the head of a launch: a path in plain double quotes for cmd (carets inside quotes
 *  stay literal), through its call operator for PowerShell. */
export function launchProgramHead(path: string, shell: AgentStartupShell): string {
  const quoted = quoteLaunchProgram(path, shell)
  return shell === 'powershell' && quoted !== path ? `& ${quoted}` : quoted
}

/** A program path as one word: a plain name reads alike in every shell. */
function quoteLaunchProgram(path: string, shell: AgentStartupShell): string {
  if (/^[\w.-]+$/.test(path)) {
    return path
  }
  return shell === 'cmd' ? `"${path}"` : quoteStartupArg(path, shell)
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

const COMMAND_SEPARATORS: ReadonlySet<string> = new Set(['&&', '||', '|', ';', '&', '{'])
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['exec', 'command'])
const POSIX_SHELL_PROGRAM = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash)$/

/** Swaps each program `command` runs, wherever a wrapper puts it (after `cd … &&`, `;`, PowerShell's
 *  `&`, `exec`, or inside `sh -c '…'`), for what `replace` names. Arguments, prompts included, are never read. */
export function replaceLaunchPrograms(
  command: string,
  shell: AgentStartupShell,
  replace: (program: string) => string | null
): string {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return command
  }
  const { tokens, spans } = parsed
  const runsProgram = (index: number): boolean =>
    index === 0 ||
    COMMAND_SEPARATORS.has(tokens[index - 1]) ||
    // An unquoted `;` closes the word before it in every shell.
    command[spans[index - 1].end - 1] === ';' ||
    (COMMAND_PREFIXES.has(tokens[index - 1]) && runsProgram(index - 1))
  let rebuilt = ''
  let copied = 0
  tokens.forEach((token, index) => {
    let text: string | null = null
    if (runsProgram(index)) {
      const next = replace(token)
      if (next && next !== token) {
        // After PowerShell's call operator the program is a plain argument to it.
        text =
          shell === 'powershell' && tokens[index - 1] === '&'
            ? quoteLaunchProgram(next, shell)
            : launchProgramHead(next, shell)
      }
    } else if (
      index >= 2 &&
      tokens[index - 1] === '-c' &&
      runsProgram(index - 2) &&
      POSIX_SHELL_PROGRAM.test(tokens[index - 2])
    ) {
      const script = replaceLaunchPrograms(token, 'posix', replace)
      text = script === token ? null : quoteStartupArg(script, shell)
    }
    if (text !== null) {
      rebuilt += command.slice(copied, spans[index].start) + text
      copied = spans[index].end
    }
  })
  return copied === 0 ? command : rebuilt + command.slice(copied)
}

/** Runs Orca's copy by full path where `command` starts with the agent's stock program; the
 *  user's own CLI (none reported) and a Command setting naming another program keep it as written. */
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
