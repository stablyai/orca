import { tokenizeCustomCommandTemplate, type CommandTokenSpan } from './commit-message-prompt'
import { quotePowerShellLiteral } from './powershell-native-argument'

/** posix output must parse identically across Unix shells including fish; remote/WSL shell detection is not reliable enough to choose a separate dialect. */
export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

type WindowsStartupShell = Extract<AgentStartupShell, 'powershell' | 'cmd'>

/** The emitted Unix forms use env prefixes, sh -c and semicolon chaining accepted by fish too. */
export function isPosixStartupShell(shell: AgentStartupShell): boolean {
  return shell === 'posix'
}

function isWindowsStartupShell(shell: AgentStartupShell): shell is WindowsStartupShell {
  return shell === 'powershell' || shell === 'cmd'
}

export type StartupCommandTokens =
  | { ok: true; tokens: string[]; spans: CommandTokenSpan[] }
  | { ok: false; error: string }

/** Odd backslashes make the quote literal to CommandLineToArgvW, so cmd/tokenizer word boundaries diverge. */
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
      // cmd strips carets outside quotes, allowing the child parser to split/reopen tokens, and keeps them inside quotes.
      // PowerShell treats continuations, single quotes, recognized escapes and leading escaped whitespace differently; mark these unmodelable.
      // Treat bare CR conservatively too: pwsh 7 retains it and Windows PowerShell 5.1 is unverified.
      divergesFromShell ||=
        (shell === 'cmd' ? /[\s"]/.test(value[index + 1]) : /[\n\r]/.test(value[index + 1])) ||
        (shell === 'cmd' && quote === '"') ||
        (shell === 'powershell' && quote === "'") ||
        // Leading backtick-whitespace disappears without producing a token.
        (shell === 'powershell' && !tokenStarted && /\s/.test(value[index + 1])) ||
        // Recognized PowerShell escapes change values in both bare and quoted arguments.
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
      // Nested quoting inside PowerShell $(…) is outside this tokenizer’s model.
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
      // cmd treats single quotes literally; grouped tokens cannot be trusted as argv.
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
      // A trailing escape would swallow a separator appended after this command.
      divergesFromShell ||= char === escape && index + 1 >= value.length
      divergesFromShell ||=
        ';&|<>'.includes(char) ||
        (shell === 'powershell' &&
          // Bare parentheses evaluate and braces create script blocks; span splicing cannot model them.
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
  // Unix settings text is tokenized once then re-quoted, so workspace shells must not change its meaning. Windows shells reparse the built line separately.
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

/** Fish single quotes interpret backslashes/apostrophes unlike sh. Emit those characters in double-quoted fragments between literal runs so all Unix shells receive the same argument.
 * Verified with sh/bash/zsh/dash/fish 4.7.1 across paths, expansions, operators, controls and Unicode; see fish-startup-arg-quoting.live-fish.test.ts. */
function quotePortableUnixArg(value: string): string {
  if (!value) {
    return "''"
  }
  const parts: string[] = []
  let literal = ''
  const flushLiteral = (): void => {
    if (literal) {
      parts.push(`'${literal}'`)
      literal = ''
    }
  }
  for (const char of value) {
    if (char === "'") {
      flushLiteral()
      parts.push(`"'"`)
    } else if (char === '\\') {
      flushLiteral()
      parts.push(`"\\\\"`)
    } else {
      literal += char
    }
  }
  flushLiteral()
  return parts.join('')
}

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return quotePowerShellLiteral(value)
  }
  if (shell === 'cmd') {
    return `"${value.replace(/([\^&|<>()%!"])/g, '^$1')}"`
  }
  return quotePortableUnixArg(value)
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

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Clear in the calling shell using self-contained fish/sh branches: copied commands may run without Orca wrappers. unset is absent in fish; sh set -e enables errexit.
 * Guard branches independently (already-unset fish erase fails), bypass test aliases with command test, and finish with true for a clean prompt status.
 * Use --erase so a false fish_pid match cannot enable sh errexit; -g preserves user universal variables while revealing any value shadowed by injected globals.
 * Known limit: sh set -u aborts on unset fish_pid; nounset-safe expansion does not parse in fish. Avoid executable probes such as math: they can launch arbitrary PATH programs (measured 10.4s).
 * Verified set/unset variables, no stderr and exit 0 in sh/bash/zsh/dash/ksh/fish; fish does not export its fish_pid marker. */
export function clearEnvCommand(
  name: string | readonly string[],
  shell: AgentStartupShell
): string {
  const names = typeof name === 'string' ? [name] : [...name]
  // Names enter shell syntax directly; require identifiers to prevent injection or deleting arbitrary session variables. Callers use fixed names.
  for (const each of names) {
    if (!ENV_VAR_NAME.test(each)) {
      throw new Error(
        `clearEnvCommand: ${JSON.stringify(each)} is not an environment variable name`
      )
    }
  }
  if (shell === 'powershell') {
    return names.map((each) => `Remove-Item Env:${each} -ErrorAction SilentlyContinue`).join('; ')
  }
  if (shell === 'cmd') {
    return names.map((each) => `set "${each}="`).join(' & ')
  }
  const joined = names.join(' ')
  return (
    `command test -n "$fish_pid" && set --erase -g ${joined}; ` +
    `command test -z "$fish_pid" && unset ${joined}; true`
  )
}

/** Change only the child environment with env -u so copied Unix launches work under set -u without expanding fish_pid.
 * Calling-shell clearEnvCommand can abort on that unset marker; verified child-only removal in sh/bash/zsh/dash/ksh/fish, including nounset. */
export function withoutEnvCommand(
  names: readonly string[],
  command: string,
  shell: AgentStartupShell
): string {
  if (names.length === 0) {
    return command
  }
  if (isWindowsStartupShell(shell)) {
    // Windows has no env -u; clear in place without a nounset mode that could abort the line.
    return `${clearEnvCommand(names, shell)}${commandSeparator(shell)}${command}`
  }
  for (const name of names) {
    if (!ENV_VAR_NAME.test(name)) {
      throw new Error(
        `withoutEnvCommand: ${JSON.stringify(name)} is not an environment variable name`
      )
    }
  }
  return `env ${names.map((name) => `-u ${name}`).join(' ')} ${command}`
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
