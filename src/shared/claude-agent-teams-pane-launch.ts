import {
  buildShellCommandFromArgv,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import {
  buildWindowsCmdShimCommandLine,
  isCmdInterpretedProgram
} from './child-process/windows-command-line'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export type ClaudeAgentTeamsPaneLaunch = {
  argv: string[]
  cwd?: string
  env: Record<string, string>
  holding: boolean
}

export type ClaudeAgentTeamsPaneSpawn = {
  command?: string
  cwd?: string
  env: Record<string, string>
  process?: Pick<ClaudeAgentTeamsPaneLaunch, 'argv' | 'holding'>
}

export function supportsClaudeAgentTeamsPaneShell(shell: AgentStartupShell): boolean {
  return shell !== 'cmd'
}

export function buildClaudeAgentTeamsPowerShellCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const [program, ...args] = argv
  if (!program) {
    return ''
  }
  if (!isCmdInterpretedProgram(program)) {
    return buildShellCommandFromArgv(argv, 'powershell')
  }
  const commandLine = buildWindowsCmdShimCommandLine(program, args)
  return `& ${quoteStartupArg(env.ComSpec ?? 'cmd.exe', 'powershell')} --% ${commandLine}`
}

/** Parses the one sh command shape emitted by Claude's tmux backend. */
export function parseClaudeAgentTeamsPaneLaunch(
  command: string
): ClaudeAgentTeamsPaneLaunch | null {
  const parsed = tokenizeStartupCommand(command, 'posix')
  if (!parsed.ok) {
    return null
  }
  const tokens = [...parsed.tokens]
  const spans = [...parsed.spans]
  let cwd: string | undefined
  if (
    tokens.length >= 3 &&
    tokens[0] === 'cd' &&
    tokens[2] === '&&' &&
    command.slice(spans[2]?.start, spans[2]?.end) !== '&&'
  ) {
    return null
  }
  if (
    tokens.length >= 4 &&
    tokens[0] === 'cd' &&
    tokens[2] === '&&' &&
    command.slice(spans[2]?.start, spans[2]?.end) === '&&'
  ) {
    if (spans[0]?.divergesFromShell || spans[1]?.divergesFromShell) {
      return null
    }
    cwd = tokens[1]
    tokens.splice(0, 3)
    spans.splice(0, 3)
  }
  const env: Record<string, string> = {}
  if (tokens[0] === 'env') {
    if (spans[0]?.divergesFromShell) {
      return null
    }
    tokens.shift()
    spans.shift()
    while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0])) {
      if (spans[0]?.divergesFromShell) {
        return null
      }
      const assignment = tokens.shift()!
      spans.shift()
      const separator = assignment.indexOf('=')
      env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
  }
  if (tokens.length === 0 || spans.some((span) => span.divergesFromShell)) {
    return null
  }
  return { argv: tokens, cwd, env, holding: tokens.length === 1 && tokens[0] === 'cat' }
}

export function resolveClaudeAgentTeamsPaneSpawn(args: {
  command: string
  shell: AgentStartupShell
  tmuxCwd?: string
}): ClaudeAgentTeamsPaneSpawn {
  if (!args.command) {
    return { cwd: args.tmuxCwd, env: {} }
  }
  if (args.shell === 'posix') {
    return { command: args.command, cwd: args.tmuxCwd, env: {} }
  }
  const launch = parseClaudeAgentTeamsPaneLaunch(args.command)
  if (!launch) {
    throw new Error('unsupported Claude teammate pane command')
  }
  return {
    cwd: launch.cwd ?? args.tmuxCwd,
    env: launch.env,
    process: { argv: launch.argv, holding: launch.holding }
  }
}
