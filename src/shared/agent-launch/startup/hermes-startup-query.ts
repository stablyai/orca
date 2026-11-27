import { encodePowerShellCommand } from '../../shell/launch/powershell-command-encoding'
import { getPowerShellEscapeNativeArgsFunction } from '../../shell/launch/powershell-native-argument'
import type { ReceivingShell } from './receiving-shell-agent-launch'
import {
  buildShellCommandFromArgv,
  isPosixStartupShell,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const QUERY_ENV_LIMIT = 24_000
const QUERY_PLACEHOLDER = '__ORCA_HERMES_STARTUP_QUERY__'
const QUERY_ARG_PLACEHOLDER = `--query=${QUERY_PLACEHOLDER}`
const POSIX_QUERY_VARIABLE = '__orca_hermes_startup_query'
const POWERSHELL_QUERY_VARIABLE = 'orcaHermesStartupQuery'
const POWERSHELL_NATIVE_QUERY_VARIABLE = 'orcaHermesNativeQuery'

export const ORCA_HERMES_STARTUP_QUERY_ENV = 'ORCA_HERMES_STARTUP_QUERY'
export const ORCA_HERMES_STARTUP_QUERY_ARGV_ENV = 'ORCA_HERMES_STARTUP_QUERY_ARGV'

function encodePosixEvalScript(command: string): string {
  return Array.from(
    new TextEncoder().encode(command),
    (byte) => `\\0${byte.toString(8).padStart(3, '0')}`
  ).join('')
}

function tokenizeCommand(value: string, shell: AgentStartupShell): string[] | null {
  const tokenized = tokenizeStartupCommand(value, shell)
  return tokenized.ok && tokenized.tokens.length > 0 ? tokenized.tokens : null
}

function isHermesExecutableToken(value: string): boolean {
  const basename = value.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return basename === 'hermes' || basename === 'hermes.exe' || basename === 'hermes.cmd'
}

const HERMES_VALUELESS_FLAGS = /* @__PURE__ */ new Set([
  '--tui',
  '--cli',
  '--verbose',
  '-v',
  '--quiet',
  '-Q',
  '--worktree',
  '-w',
  '--accept-hooks',
  '--checkpoints',
  '--yolo',
  '--pass-session-id',
  '--ignore-user-config',
  '--ignore-rules',
  '--safe-mode',
  '--dev'
])

function findChatSubcommand(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === 'chat') {
      return index
    }
    if (token.startsWith('-') && !token.includes('=') && !HERMES_VALUELESS_FLAGS.has(token)) {
      index += 1
    }
  }
  return -1
}

function stripOrcaOwnedHermesArgs(args: readonly string[]): string[] {
  const normalized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--query' || token === '-q') {
      index += 1
      continue
    }
    if (
      token.startsWith('--query=') ||
      token.startsWith('-q=') ||
      (token.startsWith('-q') && token.length > 2) ||
      token === '--tui' ||
      token === '--cli'
    ) {
      continue
    }
    normalized.push(token)
  }
  return normalized
}

function normalizeHermesArgv(
  baseArgv: string[],
  configuredArgv: string[],
  shell: AgentStartupShell
): string[] | null {
  const executableCandidates: number[] = []
  for (let index = 0; index < baseArgv.length; index += 1) {
    if (isHermesExecutableToken(baseArgv[index])) {
      executableCandidates.push(index)
    }
  }
  let anchoredExecutable: number | undefined
  for (const index of executableCandidates) {
    if (findChatSubcommand(baseArgv.slice(index + 1)) !== -1) {
      // Wrapper arguments can also be named "hermes"; the final match is the executable.
      anchoredExecutable = index
    }
  }
  const executableIndex = anchoredExecutable ?? executableCandidates.at(-1) ?? -1
  if (executableIndex === -1) {
    return null
  }
  let commandPrefix = baseArgv.slice(0, executableIndex + 1)
  let assignmentCount = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(commandPrefix[assignmentCount] ?? '')) {
    assignmentCount += 1
  }
  if (assignmentCount > 0) {
    if (!isPosixStartupShell(shell)) {
      return null
    }
    commandPrefix = ['env', ...commandPrefix]
  }
  const baseArgs = baseArgv.slice(executableIndex + 1)
  const chatIndex = findChatSubcommand(baseArgs)
  const baseArgsWithoutChat =
    chatIndex === -1 ? baseArgs : baseArgs.filter((_, index) => index !== chatIndex)
  const configuredChatIndex = findChatSubcommand(configuredArgv)
  const configuredArgsWithoutChat =
    configuredChatIndex === -1
      ? configuredArgv
      : configuredArgv.filter((_, index) => index !== configuredChatIndex)
  return [
    ...commandPrefix,
    'chat',
    QUERY_ARG_PLACEHOLDER,
    ...stripOrcaOwnedHermesArgs(baseArgsWithoutChat),
    ...stripOrcaOwnedHermesArgs(configuredArgsWithoutChat),
    '--tui'
  ]
}

export function buildHermesQueryCommand(
  argv: readonly string[],
  shell: AgentStartupShell,
  programExpression?: string
): string {
  const render = (syntax: 'powershell' | 'posix'): string => {
    if (!programExpression) {
      return buildShellCommandFromArgv(argv, syntax)
    }
    const args = argv.slice(1).map((arg) => quoteStartupArg(arg, syntax))
    return [syntax === 'powershell' ? `& ${programExpression}` : programExpression, ...args].join(
      ' '
    )
  }
  if (!isPosixStartupShell(shell)) {
    const invocation = render('powershell').replace(
      quoteStartupArg(QUERY_ARG_PLACEHOLDER, 'powershell'),
      `"--query=$${POWERSHELL_NATIVE_QUERY_VARIABLE}"`
    )
    // Remove startup prompts from child-tool env; the long-lived parent retains transport env for compatibility.
    // PowerShell 5 requires native-Windows quote escaping before constructing argv.
    const script = `$${POWERSHELL_QUERY_VARIABLE} = $env:${ORCA_HERMES_STARTUP_QUERY_ENV}; $${POWERSHELL_NATIVE_QUERY_VARIABLE} = $${POWERSHELL_QUERY_VARIABLE} -replace '(\\\\*)"', '$1$1\\"'; Remove-Item Env:${ORCA_HERMES_STARTUP_QUERY_ENV} -ErrorAction SilentlyContinue; ${invocation}`
    return `powershell.exe -NoProfile -EncodedCommand ${encodePowerShellCommand(script)}`
  }
  const invocation = render('posix').replace(
    quoteStartupArg(QUERY_ARG_PLACEHOLDER, 'posix'),
    `"--query=\${${POSIX_QUERY_VARIABLE}}"`
  )
  const encodedInvocation = encodePosixEvalScript(invocation)
  // Keep the wrapper single-quote-safe for POSIX/pwsh; decode dynamic argv only inside known sh grammar.
  const script = `${POSIX_QUERY_VARIABLE}="\${${ORCA_HERMES_STARTUP_QUERY_ENV}}"; unset ${ORCA_HERMES_STARTUP_QUERY_ENV}; eval "$(printf %b "${encodedInvocation}")"`
  // Outer quoting is parsed by the typing shell, even though the body uses sh; octal payload escapes only happen to survive POSIX quoting in fish.
  return `sh -c ${quoteStartupArg(script, shell)}`
}

export function buildReceivingHermesQueryCommand(
  argv: readonly [string, ...string[]],
  shell: ReceivingShell
): string {
  const [name, ...args] = argv
  const query = POSIX_QUERY_VARIABLE
  const queryArg = shell === 'powershell' ? '$orcaHermesQueryArg' : `"--query=$${query}"`
  const invocation = [
    name,
    ...args.map((arg) =>
      arg === QUERY_ARG_PLACEHOLDER
        ? queryArg
        : quoteStartupArg(arg, shell === 'powershell' ? shell : 'posix')
    )
  ].join(' ')
  if (shell === 'powershell') {
    const escape = getPowerShellEscapeNativeArgsFunction({ inline: true })
    const readTarget = `$orcaHermesTarget = Get-Command ${name} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($orcaHermesTarget -is [System.Management.Automation.AliasInfo]) { $orcaHermesTarget = $orcaHermesTarget.ResolvedCommand }`
    const escapeQuery = `if ($orcaHermesTarget -is [System.Management.Automation.ApplicationInfo]) { ${escape}; $orcaHermesQueryArg = @(__OrcaEscapeNativeArgs $orcaHermesTarget.Source @($orcaHermesQueryArg))[0] }`
    return `& { $orcaHermesQueryArg = "--query=$env:${ORCA_HERMES_STARTUP_QUERY_ENV}"; Remove-Item Env:${ORCA_HERMES_STARTUP_QUERY_ENV} -ErrorAction SilentlyContinue; ${readTarget}; ${escapeQuery}; ${invocation} }`
  }
  if (shell === 'fish') {
    return `begin; set -l ${query} "$${ORCA_HERMES_STARTUP_QUERY_ENV}"; set -eg ${ORCA_HERMES_STARTUP_QUERY_ENV}; ${invocation}; end`
  }
  return `(${query}="\${${ORCA_HERMES_STARTUP_QUERY_ENV}-}"; unset ${ORCA_HERMES_STARTUP_QUERY_ENV}; ${invocation})`
}

export function readGeneratedHermesQueryArgv(
  value: string | undefined,
  command: string,
  shell: AgentStartupShell
): string[] | undefined {
  if (!value) {
    return undefined
  }
  try {
    const argv: unknown = JSON.parse(value)
    return Array.isArray(argv) &&
      argv.every((arg): arg is string => typeof arg === 'string') &&
      matchesGeneratedHermesQuery(argv, command, shell)
      ? argv
      : undefined
  } catch {
    return undefined
  }
}

export function matchesGeneratedHermesQuery(
  argv: readonly string[],
  command: string,
  shell: AgentStartupShell
): boolean {
  return (
    isHermesExecutableToken(argv[0] ?? '') &&
    argv[1] === 'chat' &&
    argv[2] === QUERY_ARG_PLACEHOLDER &&
    buildHermesQueryCommand(argv, shell) === command
  )
}

export function hermesStartupQueryFits(
  command: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform
): boolean {
  const envSize = Object.entries(env).reduce((total, [key, value]) => {
    if (platform === 'win32') {
      return total + key.length + value.length + 2
    }
    return total + new TextEncoder().encode(`${key}=${value}`).byteLength + 1
  }, 0)
  const commandSize =
    platform === 'win32' ? command.length : new TextEncoder().encode(command).byteLength
  // WSL executes Linux plans through the Windows environment block; use a conservative bound safe across transports.
  return commandSize + envSize <= QUERY_ENV_LIMIT
}

export function planHermesStartupQuery(args: {
  baseCommand: string
  agentArgs?: string | null
  prompt: string
  agentEnv?: Record<string, string> | null
  platform: NodeJS.Platform
  shell: AgentStartupShell
  isRemote?: boolean
  generated?: boolean
}): { command: string; env: Record<string, string> } | null {
  const baseArgv = tokenizeCommand(args.baseCommand, args.shell)
  const configuredArgv = args.agentArgs?.trim() ? tokenizeCommand(args.agentArgs, args.shell) : []
  if (!baseArgv || !configuredArgv) {
    return null
  }
  const argv = normalizeHermesArgv(baseArgv, configuredArgv, args.shell)
  if (!argv) {
    return null
  }
  const command = buildHermesQueryCommand(argv, args.shell)
  const env: Record<string, string> = {
    ...args.agentEnv,
    [ORCA_HERMES_STARTUP_QUERY_ENV]: args.prompt
  }
  if (!hermesStartupQueryFits(command, env, args.platform)) {
    return null
  }
  // Rebuild metadata is stripped before pane spawn.
  if (args.generated) {
    env[ORCA_HERMES_STARTUP_QUERY_ARGV_ENV] = JSON.stringify(argv)
  }
  return { command, env }
}
