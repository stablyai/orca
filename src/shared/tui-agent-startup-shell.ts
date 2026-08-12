import { tokenizeCustomCommandTemplate } from './commit-message-prompt'
import type { TuiAgentConfig } from './tui-agent-config'
import type { SessionOptionValue } from './native-chat-session-options'

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

export const MAX_INLINE_SESSION_RULES_LENGTH = 8_000

export type StartupCommandTokens = { ok: true; tokens: string[] } | { ok: false; error: string }

function tokenizeWindowsStartupCommand(
  value: string,
  shell: Exclude<AgentStartupShell, 'posix'>
): StartupCommandTokens {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let tokenStarted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const escape = shell === 'cmd' ? '^' : '`'
    if (char === escape && index + 1 < value.length) {
      token += value[index + 1]
      tokenStarted = true
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) {
        if (shell === 'powershell' && quote === "'" && value[index + 1] === "'") {
          token += "'"
          index += 1
        } else {
          quote = null
        }
      } else {
        token += char
      }
      tokenStarted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
    } else {
      token += char
      tokenStarted = true
    }
  }
  if (quote) {
    return { ok: false, error: 'Unclosed quote in command template.' }
  }
  if (tokenStarted) {
    tokens.push(token)
  }
  return { ok: true, tokens }
}

export function tokenizeStartupCommand(
  value: string,
  shell: AgentStartupShell
): StartupCommandTokens {
  return shell === 'posix'
    ? tokenizeCustomCommandTemplate(value)
    : tokenizeWindowsStartupCommand(value, shell)
}

export function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

export function resolveSessionRulesDeliveryShell(args: {
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote?: boolean
}): AgentStartupShell {
  // Why: the SSH relay may apply a per-tab cmd.exe override that the planner cannot observe.
  if (args.platform === 'win32' && args.isRemote && args.shell === undefined) {
    return 'cmd'
  }
  return resolveStartupShell(args.platform, args.shell)
}

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `'${value.replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    // Why: cmd treats CR/LF as command boundaries even inside quoted startup arguments.
    const singleLine = value.replace(/\r\n?|\n/g, ' ')
    return `"${singleLine.replace(/([\^&|<>()%!"])/g, '^$1')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function appliedSessionOptionProps(values: Record<string, SessionOptionValue>) {
  return Object.keys(values).length > 0 ? { sessionOptions: { ...values } } : {}
}

export function hasNativeSessionRulesInjection(
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  rulesText: string | null | undefined,
  shell?: AgentStartupShell
): boolean {
  const trimmedRules = rulesText?.trim()
  const canInlineRules =
    Boolean(trimmedRules) &&
    shell !== 'cmd' &&
    (trimmedRules?.length ?? 0) <= MAX_INLINE_SESSION_RULES_LENGTH
  return Boolean(
    (config.sessionRulesFileFlag && filePath) ||
    ((config.sessionRulesTextFlag || config.sessionRulesConfigKey) && canInlineRules)
  )
}

export function sessionRulesTextRequiresPostReadyDelivery(
  rulesText: string | null | undefined,
  shell: AgentStartupShell
): boolean {
  const trimmedRules = rulesText?.trim()
  return Boolean(
    trimmedRules && (shell === 'cmd' || trimmedRules.length > MAX_INLINE_SESSION_RULES_LENGTH)
  )
}

function appendOptionBeforeTerminator(
  command: string,
  option: string,
  shell: AgentStartupShell
): string {
  const marker = ` ${quoteStartupArg('--', shell)}`
  const terminator = command.indexOf(marker)
  if (terminator === -1) {
    return `${command} ${option}`
  }
  return `${command.slice(0, terminator)} ${option}${command.slice(terminator)}`
}

// Why: applied only to this launch command; wake/resume re-resolves the current rules.
export function appendSessionRulesFlag(
  command: string,
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  rulesText: string | null | undefined,
  shell: AgentStartupShell
): string {
  if (config.sessionRulesFileFlag && filePath) {
    return appendOptionBeforeTerminator(
      command,
      `${config.sessionRulesFileFlag} ${quoteStartupArg(filePath, shell)}`,
      shell
    )
  }
  const trimmedRules = rulesText?.trim()
  if (!trimmedRules || sessionRulesTextRequiresPostReadyDelivery(trimmedRules, shell)) {
    return command
  }
  if (config.sessionRulesTextFlag) {
    return appendOptionBeforeTerminator(
      command,
      `${config.sessionRulesTextFlag} ${quoteStartupArg(trimmedRules, shell)}`,
      shell
    )
  }
  if (config.sessionRulesConfigKey) {
    const configOverride = `${config.sessionRulesConfigKey}=${JSON.stringify(trimmedRules)}`
    return appendOptionBeforeTerminator(
      command,
      `-c ${quoteStartupArg(configOverride, shell)}`,
      shell
    )
  }
  return command
}

export function appendSessionRulesFileCleanup(
  command: string,
  filePath: string | null | undefined,
  shell: AgentStartupShell
): string {
  if (!filePath) {
    return command
  }
  const quotedPath = quoteStartupArg(filePath, shell)
  if (shell === 'posix') {
    return `${command}; _orca_agent_status=$?; rm -f -- ${quotedPath}; (exit "$_orca_agent_status")`
  }
  if (shell === 'powershell') {
    return `${command}; $_orcaAgentStatus=$LASTEXITCODE; Remove-Item -LiteralPath ${quotedPath} -Force -ErrorAction SilentlyContinue; $global:LASTEXITCODE=$_orcaAgentStatus`
  }
  return `${command} & del /f /q ${quotedPath} >nul 2>&1`
}

export function prependSessionRulesToPrompt(prompt: string, rulesText: string): string {
  return `## Agent session rules\n\n${rulesText.trim()}\n\n## User request\n\n${prompt}`
}

export function buildAgentSessionRulesOnlyDraft(
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  rulesText: string | null | undefined,
  shell: AgentStartupShell
): string | null {
  if (!rulesText?.trim() || hasNativeSessionRulesInjection(config, filePath, rulesText, shell)) {
    return null
  }
  return prependSessionRulesToPrompt('', rulesText)
}

export function buildShellCommandFromArgv(
  args: readonly string[],
  shell: AgentStartupShell
): string {
  const command = args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (shell === 'powershell' && command) {
    return `& ${command}`
  }
  return command
}

export function clearEnvCommand(name: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
  }
  if (shell === 'cmd') {
    return `set "${name}="`
  }
  return `unset ${name}`
}

export function commandSeparator(shell: AgentStartupShell): string {
  return shell === 'cmd' ? ' & ' : '; '
}

export type AgentCliArgsPlan = { ok: true; suffix: string } | { ok: false; error: string }

export function planAgentCliArgsSuffix(
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): AgentCliArgsPlan {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, suffix: '' }
  }
  const tokenized = tokenizeStartupCommand(trimmed, shell)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return {
    ok: true,
    suffix: tokenized.tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
  }
}
