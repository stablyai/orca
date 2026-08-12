import { tokenizeCustomCommandTemplate, type CommandTokenSpan } from './commit-message-prompt'
import type { TuiAgentConfig } from './tui-agent-config'
import type { SessionOptionValue } from './native-chat-session-options'

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

/** Shell dialect used for encoding session-rules delivery (flag args, file cleanup); mirrors resolveStartupShell. */
export function resolveSessionRulesDeliveryShell(args: {
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote?: boolean
}): AgentStartupShell {
  return resolveStartupShell(args.platform, args.shell)
}

/** Whether session rules must wait until the agent is ready (delivered as a paste-and-submit follow-up)
 * rather than being baked into the initial launch command/prompt at all — regardless of whether a native
 * flag would otherwise apply. cmd.exe's quoting has no reliable way to carry arbitrary multi-line rules
 * text (native flag or prepended prompt alike), so every delivery path defers there. */
export function sessionRulesTextRequiresPostReadyDelivery(
  text: string | null | undefined,
  shell: AgentStartupShell
): boolean {
  return shell === 'cmd' && Boolean(text?.trim())
}

/** True when the agent has a confirmed native flag for session rules (text on argv, or a file path) and
 * there is rules content to deliver, and the current shell can reliably carry it inline. False whenever
 * sessionRulesTextRequiresPostReadyDelivery is true, even if a flag is configured — availability means
 * "safe to use now", not just "a flag name exists". A file path is exempt from that shell check: only a
 * short path is being quoted (not the arbitrary multi-line rules text itself), so it is safe to use
 * inline even on cmd.exe or across a Windows-to-WSL boundary where inline text is not. */
export function hasNativeSessionRulesInjection(
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  text: string | null | undefined,
  shell: AgentStartupShell | undefined
): boolean {
  if (config.sessionRulesFileFlag && filePath) {
    return true
  }
  if (shell && sessionRulesTextRequiresPostReadyDelivery(text, shell)) {
    return false
  }
  return Boolean(config.sessionRulesTextFlag && text?.trim())
}

/** Wrap session rules ahead of a (possibly empty) user section, under matching headers so the two are
 * visually distinguishable once combined into a single prompt/draft string. */
function wrapSessionRulesText(rulesText: string, userSection: string): string {
  return `## Agent session rules\n${rulesText}\n\n## User request\n${userSection}`
}

/** Prepend session rules text ahead of the user's prompt, for agents with no native injection. */
export function prependSessionRulesToPrompt(prompt: string, rulesText: string): string {
  return wrapSessionRulesText(rulesText, prompt)
}

/** Build a draft prompt containing only session rules (no user prompt), for pre-filling the composer
 * ahead of a paste-after-ready launch. Null when native injection will carry the rules instead, since
 * the composer needs nothing extra in that case. */
export function buildAgentSessionRulesOnlyDraft(
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  text: string | null | undefined,
  shell: AgentStartupShell
): string | null {
  if (hasNativeSessionRulesInjection(config, filePath, text, shell) || !text?.trim()) {
    return null
  }
  return wrapSessionRulesText(text, '')
}

/** Append the native session-rules flag to a launch command — a file-path flag when a rules file was
 * actually written for this launch (safe to quote inline anywhere), else text-on-argv when the agent
 * supports that instead. */
export function appendSessionRulesFlag(
  command: string,
  config: TuiAgentConfig,
  filePath: string | null | undefined,
  text: string | null | undefined,
  shell: AgentStartupShell
): string {
  if (config.sessionRulesFileFlag && filePath) {
    return `${command} ${config.sessionRulesFileFlag} ${quoteStartupArg(filePath, shell)}`
  }
  if (config.sessionRulesTextFlag && text?.trim()) {
    return `${command} ${config.sessionRulesTextFlag} ${quoteStartupArg(text, shell)}`
  }
  return command
}

/** Append a Codex-style `-c key=value` config-override flag carrying session rules, when the agent
 * declares one. Unconditional by design (see TuiAgentConfig.sessionRulesConfigOverride): applied
 * whenever there is rules text and the shell can safely carry it inline, on top of whatever
 * prepend-to-prompt/paste-after-ready fallback the caller also applies for this agent. */
export function appendSessionRulesConfigOverride(
  command: string,
  config: TuiAgentConfig,
  text: string | null | undefined,
  shell: AgentStartupShell
): string {
  if (
    !config.sessionRulesConfigOverride ||
    !text?.trim() ||
    sessionRulesTextRequiresPostReadyDelivery(text, shell)
  ) {
    return command
  }
  const { flag, key } = config.sessionRulesConfigOverride
  return `${command} ${flag} ${quoteStartupArg(`${key}=${text}`, shell)}`
}

/** Append the shell-appropriate cleanup for a temporary session-rules file, when one was written. */
export function appendSessionRulesFileCleanup(
  command: string,
  filePath: string | null | undefined,
  shell: AgentStartupShell
): string {
  if (!filePath) {
    return command
  }
  const quoted = quoteStartupArg(filePath, shell)
  const cleanup =
    shell === 'powershell'
      ? `Remove-Item ${quoted} -ErrorAction SilentlyContinue`
      : shell === 'cmd'
        ? `del /f /q ${quoted}`
        : `rm -f ${quoted}`
  return `${command}${commandSeparator(shell)}${cleanup}`
}

/** Project applied session options into the launch-plan shape, omitting the key entirely when empty. */
export function appliedSessionOptionProps(
  appliedSessionOptions: Record<string, SessionOptionValue>
): { sessionOptions?: Record<string, SessionOptionValue> } {
  return Object.keys(appliedSessionOptions).length > 0
    ? { sessionOptions: appliedSessionOptions }
    : {}
}
