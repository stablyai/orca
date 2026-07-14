import {
  buildShellCommandFromArgv,
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

function encodePowerShellCommand(command: string): string {
  let bytes = ''
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}

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

const HERMES_VALUELESS_FLAGS = new Set([
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
    if (shell !== 'posix') {
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

function buildQueryCommand(argv: string[], shell: AgentStartupShell): string {
  if (shell !== 'posix') {
    const invocation = buildShellCommandFromArgv(argv, 'powershell').replace(
      quoteStartupArg(QUERY_ARG_PLACEHOLDER, 'powershell'),
      `"--query=$${POWERSHELL_NATIVE_QUERY_VARIABLE}"`
    )
    // Why: startup prompts must not remain exported to Hermes tools; the
    // long-lived parent shell retains the transport env for compatibility.
    // PowerShell 5 needs Windows-native quote escaping before building child argv.
    const script = `$${POWERSHELL_QUERY_VARIABLE} = $env:${ORCA_HERMES_STARTUP_QUERY_ENV}; $${POWERSHELL_NATIVE_QUERY_VARIABLE} = $${POWERSHELL_QUERY_VARIABLE} -replace '(\\\\*)"', '$1$1\\"'; Remove-Item Env:${ORCA_HERMES_STARTUP_QUERY_ENV} -ErrorAction SilentlyContinue; ${invocation}`
    return `powershell.exe -NoProfile -EncodedCommand ${encodePowerShellCommand(script)}`
  }
  const invocation = buildShellCommandFromArgv(argv, 'posix').replace(
    quoteStartupArg(QUERY_ARG_PLACEHOLDER, 'posix'),
    `"--query=\${${POSIX_QUERY_VARIABLE}}"`
  )
  const encodedInvocation = encodePosixEvalScript(invocation)
  // Why: a fixed single-quote-safe wrapper parses in POSIX shells and pwsh;
  // the dynamic argv is decoded only after entering the known `sh` grammar.
  const script = `${POSIX_QUERY_VARIABLE}="\${${ORCA_HERMES_STARTUP_QUERY_ENV}}"; unset ${ORCA_HERMES_STARTUP_QUERY_ENV}; eval "$(printf %b "${encodedInvocation}")"`
  return `sh -c ${quoteStartupArg(script, 'posix')}`
}

export function planHermesStartupQuery(args: {
  baseCommand: string
  agentArgs?: string | null
  prompt: string
  agentEnv?: Record<string, string> | null
  platform: NodeJS.Platform
  shell: AgentStartupShell
  isRemote?: boolean
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
  const command = buildQueryCommand(argv, args.shell)
  const env = { ...args.agentEnv, [ORCA_HERMES_STARTUP_QUERY_ENV]: args.prompt }
  const envSize = Object.entries(env).reduce((total, [key, value]) => {
    if (args.platform === 'win32') {
      return total + key.length + value.length + 2
    }
    return total + new TextEncoder().encode(`${key}=${value}`).byteLength + 1
  }, 0)
  const commandSize =
    args.platform === 'win32' ? command.length : new TextEncoder().encode(command).byteLength
  // Why: WSL plans execute as Linux but cross the Windows environment block;
  // the conservative shared bound is safe for every transport host.
  return commandSize + envSize <= QUERY_ENV_LIMIT ? { command, env } : null
}
