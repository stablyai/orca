import { tokenizeCustomCommandTemplate } from './commit-message-prompt'

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

export function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell,
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

export function quoteStartupArg(
  value: string,
  shell: AgentStartupShell,
): string {
  if (shell === 'powershell') {
    return `'${value.replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    return `"${value.replace(/([\^&|<>()%!"])/g, '^$1')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildShellCommandFromArgv(
  args: readonly string[],
  shell: AgentStartupShell,
): string {
  const command = args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (shell === 'powershell' && command) {
    return `& ${command}`
  }
  return command
}

export function clearEnvCommand(
  name: string,
  shell: AgentStartupShell,
): string {
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

export type AgentCliArgsPlan =
  | { ok: true; suffix: string }
  | { ok: false; error: string }
type TokenizeCliArgsResult =
  | { ok: true; tokens: string[] }
  | { ok: false; error: string }

function tokenizeCliArgsTemplate(
  template: string,
  shell: AgentStartupShell,
): TokenizeCliArgsResult {
  if (shell === 'posix') {
    return tokenizeCustomCommandTemplate(template)
  }
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < template.length) {
    const ch = template[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && template[i + 1] === '"') {
        current += '"'
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        inToken = true
        i++
        continue
      }
      current += ch
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      i++
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      i++
      continue
    }

    current += ch
    inToken = true
    i++
  }

  if (quote) {
    return { ok: false, error: 'Unclosed quote in command template.' }
  }
  if (inToken) {
    tokens.push(current)
  }
  return { ok: true, tokens }
}

export function planAgentCliArgsSuffix(
  agentArgs: string | null | undefined,
  shell: AgentStartupShell,
): AgentCliArgsPlan {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, suffix: '' }
  }
  const tokenized = tokenizeCliArgsTemplate(trimmed, shell)
  if (!tokenized.ok) {
    return {
      ok: false,
      error: `CLI arguments are invalid: ${tokenized.error}`,
    }
  }
  return {
    ok: true,
    suffix: tokenized.tokens
      .map((token) => quoteStartupArg(token, shell))
      .join(' '),
  }
}
