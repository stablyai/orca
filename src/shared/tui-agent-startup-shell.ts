import { tokenizeCustomCommandTemplate, type CommandTokenSpan } from './commit-message-prompt'

// Why: fish shares POSIX word splitting, quoting and `;` chaining, so it is a
// separate dialect only where its grammar actually diverges (env clearing).
export type AgentStartupShell = 'posix' | 'fish' | 'powershell' | 'cmd'

type WindowsStartupShell = Extract<AgentStartupShell, 'powershell' | 'cmd'>

/** True for shells parsed with POSIX quoting/word rules (sh family + fish). */
export function isPosixStartupShell(shell: AgentStartupShell): boolean {
  return shell === 'posix' || shell === 'fish'
}

function isWindowsStartupShell(shell: AgentStartupShell): shell is WindowsStartupShell {
  return shell === 'powershell' || shell === 'cmd'
}

/** Maps a POSIX login-shell path (`$SHELL`) to the dialect that parses queued commands. */
export function resolveLoginShellStartupDialect(
  loginShell: string | null | undefined
): AgentStartupShell {
  const basename = loginShell?.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return basename === 'fish' ? 'fish' : 'posix'
}

export type StartupCommandTokens =
  | { ok: true; tokens: string[]; spans: CommandTokenSpan[] }
  | { ok: false; error: string }

/** True when an odd run of backslashes precedes this quote, which makes it a
 * literal byte to the child's CommandLineToArgvW parser rather than a
 * delimiter — so cmd's word boundaries stop matching this tokenizer's. */
function hasOddBackslashRun(value: string, quoteIndex: number): boolean {
  let backslashes = 0
  while (value[quoteIndex - 1 - backslashes] === '\\') {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function tokenizeWindowsStartupCommand(
  value: string,
  shell: WindowsStartupShell
): StartupCommandTokens {
  const tokens: string[] = []
  const spans: CommandTokenSpan[] = []
  let token = ''
  let tokenStart = 0
  let divergesFromShell = false
  let quote: "'" | '"' | null = null
  let tokenStarted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const escape = shell === 'cmd' ? '^' : '`'
    if (char === escape && index + 1 < value.length) {
      // Why: cmd strips `^` and hands the bare byte to the child's parser,
      // which re-splits on whitespace and reopens a quote, and keeps the caret
      // literal inside double quotes — either way the token stops matching
      // argv. PowerShell folds the backtick into the token except for LF line
      // continuations, verbatim single quotes, escape sequences, and a
      // token-leading backtick before whitespace, which it drops entirely.
      // A bare CR is treated as unmodelable rather than folded: pwsh 7 keeps
      // it in the token, Windows PowerShell 5.1 is unverified, and failing
      // open there costs nothing.
      divergesFromShell ||=
        (shell === 'cmd' ? /[\s"]/.test(value[index + 1]) : /[\n\r]/.test(value[index + 1])) ||
        (shell === 'cmd' && quote === '"') ||
        (shell === 'powershell' && quote === "'") ||
        // A token-leading backtick before whitespace is dropped with the
        // whitespace, emitting no token at all rather than the one built here.
        (shell === 'powershell' && !tokenStarted && /\s/.test(value[index + 1])) ||
        // PowerShell expands these escape sequences in quoted AND bare
        // arguments, so the token value this branch builds is not argv's.
        (shell === 'powershell' && '0abefnrtuv'.includes(value[index + 1]))
      token += value[index + 1]
      if (!tokenStarted) {
        tokenStart = index
      }
      tokenStarted = true
      index += 1
      continue
    }
    if (quote) {
      // Why: see the posix tokenizer — a `"` inside $(…) re-opens a nested
      // quoting context that this tokenizer does not model.
      divergesFromShell ||=
        shell === 'powershell' &&
        quote === '"' &&
        char === '$' &&
        (value[index + 1] === '(' || value[index + 1] === '{')
      if (char === quote) {
        divergesFromShell ||= shell === 'cmd' && char === '"' && hasOddBackslashRun(value, index)
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
      divergesFromShell ||= shell === 'cmd' && char === '"' && hasOddBackslashRun(value, index)
      quote = char
      // Why: cmd.exe has no single-quote syntax, so this tokenizer's grouping
      // of a single-quoted region diverges from what cmd actually parses;
      // flag the token so consumers treat it as unmodelable.
      divergesFromShell ||= shell === 'cmd' && char === "'"
      if (!tokenStarted) {
        tokenStart = index
      }
      tokenStarted = true
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token)
        spans.push({ start: tokenStart, end: index, divergesFromShell })
        token = ''
        tokenStarted = false
        divergesFromShell = false
      }
    } else {
      if (!tokenStarted) {
        tokenStart = index
      }
      // Why: see the posix tokenizer — a trailing unpaired escape would
      // swallow the separator before anything appended to the base.
      divergesFromShell ||= char === escape && index + 1 >= value.length
      divergesFromShell ||=
        ';&|<>'.includes(char) ||
        (shell === 'powershell' &&
          // Why: bare (…) is evaluated and {…} is a script block in argument
          // position, so both are live syntax the span splice cannot model.
          ('(){}'.includes(char) ||
            (char === '#' && !tokenStarted) ||
            (char === '$' && (value[index + 1] === '(' || value[index + 1] === '{'))))
      token += char
      tokenStarted = true
    }
  }
  if (quote) {
    return { ok: false, error: 'Unclosed quote in command template.' }
  }
  if (tokenStarted) {
    tokens.push(token)
    spans.push({ start: tokenStart, end: value.length, divergesFromShell })
  }
  return { ok: true, tokens, spans }
}

export function tokenizeStartupCommand(
  value: string,
  shell: AgentStartupShell
): StartupCommandTokens {
  return isWindowsStartupShell(shell)
    ? tokenizeWindowsStartupCommand(value, shell)
    : tokenizeCustomCommandTemplate(value)
}

export function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
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
  // Why: fish has no `unset`; the sh spelling errors out and silently leaves
  // the variable exported (e.g. an account-routed CODEX_HOME survives).
  if (shell === 'fish') {
    return `set -e ${name}`
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
