import { tokenizeCustomCommandTemplate, type CommandTokenSpan } from './commit-message-prompt'

/**
 * `'posix'` covers every Unix shell Orca can type into, fish included — not
 * because they agree, but because everything this module emits for it is built
 * to be correct in all of them (see quoteStartupArg and clearEnvCommand). There
 * is deliberately no fish member: a dialect Orca has to detect is a dialect it
 * can get wrong, and it cannot detect one reliably for a remote or WSL host.
 */
export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

type WindowsStartupShell = Extract<AgentStartupShell, 'powershell' | 'cmd'>

/** True for the sh-family grammar: `NAME=value cmd` prefixes, `sh -c` wrapping
 *  and `;` chaining. fish parses all three, so this holds for fish too. */
export function isPosixStartupShell(shell: AgentStartupShell): boolean {
  return shell === 'posix'
}

function isWindowsStartupShell(shell: AgentStartupShell): shell is WindowsStartupShell {
  return shell === 'powershell' || shell === 'cmd'
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
  // Why one Unix parse: the input is a string the user typed into an Orca
  // settings field, and the shell never parses it — every token is re-quoted by
  // quoteStartupArg before the line is built. Parsing it differently per shell
  // would make the same setting mean different things in different workspaces.
  // (Windows is genuinely different: cmd/PowerShell re-parse the built line.)
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

/**
 * Quotes one argument so the SAME text is literal in every Unix shell Orca can
 * be typing into — sh, bash, zsh, dash and fish.
 *
 * Why not plain sh quoting: fish's single quotes are not literal. Inside `'…'`
 * it treats `\\` and `\'` as escapes, so the sh `'\''` idiom collapses every
 * backslash (a `\d+` regex, a `\\server\share` UNC path) and a trailing
 * backslash is a hard syntax error that kills the launch outright.
 *
 * Both shell families agree on two things: a single-quoted run is literal apart
 * from those escapes, and `"\\"` is one backslash. So emitting backslashes as
 * `"\\"` and apostrophes as `"'"` between single-quoted runs round-trips in all
 * of them, and Orca never has to know which shell will read the line.
 *
 * Verified against sh, bash, zsh, dash and fish 4.7.1 over regex escapes, UNC
 * and drive paths, trailing/lone backslashes, mixed quotes, `$`/backtick/`$()`
 * expansions, globs, braces, operators, comments, newlines, tabs and non-BMP
 * unicode — see fish-startup-arg-quoting.live-fish.test.ts.
 */
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
    return `'${value.replace(/'/g, "''")}'`
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

/**
 * Clears one or more environment variables, in a form correct in every shell a
 * queued command line can land in.
 *
 * Why it carries its own fish/sh branch rather than a single builtin: `unset`
 * does not exist in fish, and `set -e` in bash enables errexit rather than
 * clearing anything, so neither spelling is safe alone.
 *
 * Why not a helper function defined by Orca's shell wrappers: Orca only wraps
 * zsh, bash and fish. A login shell of `sh`, `dash` or `ksh` launches
 * UNWRAPPED, and this text is also copied to the clipboard and pasted into
 * shells Orca never spawned — in all of those a helper would be `command not
 * found`, which is the exact failure this exists to avoid.
 *
 * Why two statements rather than `A && B || C`: in fish, `set -e` on a variable
 * that is already unset returns non-zero, so an `||` fallback would run the sh
 * branch too and print `Unknown command: unset`. Each branch is guarded by its
 * own test, so exactly one runs and the other is only parsed.
 *
 * The trailing `true` pins the exit status at 0: the guard that does NOT fire
 * leaves a non-zero status behind, and this is the last statement of a launch
 * line, so that status is what the user's prompt would render.
 *
 * `command test` rather than `test`, because an interactive shell expands
 * aliases and `alias test=...` would otherwise skip both branches silently.
 *
 * `set --erase` rather than `set -e`, because `$fish_pid` is a heuristic: any
 * non-empty value takes the fish branch. `set -e NAME` in the sh family enables
 * errexit and replaces the positional parameters, silently changing the
 * semantics of everything after it. `set --erase NAME` is the same erase in
 * fish, but in sh `--` ends option parsing, so a misfire is a usage message on
 * stderr and nothing else.
 *
 * `$fish_pid` is set by fish 3.0+ and by nothing in the sh family, and fish
 * does not export it, so a fish parent cannot make a bash child misread itself.
 *
 * `-g` is not optional: it scopes the erase to fish's GLOBAL scope, which is
 * where an inherited environment variable lands. Without it, a name that exists
 * only as a UNIVERSAL — `set -Ux CODEX_HOME …`, a perfectly normal thing for a
 * fish user to have — is permanently deleted from every future session. That is
 * real data loss to undo one launch's injection, and it is reachable from the
 * clipboard command, which a user may run with no Orca-injected value at all.
 * With `-g`, a universal shadowed by an injected global is revealed again
 * instead, which is the wanted outcome.
 *
 * KNOWN LIMIT: under `set -u` the sh side aborts on the unset `$fish_pid` and
 * the variable survives. `${fish_pid-}` would be nounset-safe but is a fish
 * parse error, and so is `set +u`.
 *
 * The one spelling that does satisfy both is a fish-builtin probe — e.g.
 * `math 1 >/dev/null 2>&1 && … || …` — because it references no variable at
 * all. Rejected deliberately: it EXECUTES whatever that name resolves to on
 * the user's PATH, twice. `math` is a real binary (Wolfram Mathematica ships
 * `/usr/local/bin/math`); measured with one on PATH, clearing a single variable
 * took 10.4s and then did not clear it, because a probe that exits 0 is an
 * unconditional false positive. Trading a rare uncleared prefill for an
 * arbitrary program execution on the launch path is the wrong direction.
 *
 * Verified to clear the variables, write nothing to stderr and exit 0 — whether
 * they were set or already unset — in sh, bash, zsh, dash, ksh and fish.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function clearEnvCommand(
  name: string | readonly string[],
  shell: AgentStartupShell
): string {
  const names = typeof name === 'string' ? [name] : [...name]
  // Why assert rather than escape: these names are interpolated straight into a
  // shell line, so anything but an identifier is both a command injection and —
  // in fish, where `-g` erases for real — a way to delete `PATH`/`HOME` out of
  // the user's session. Every caller passes a literal from a fixed table, so
  // this cannot fire today; it exists so it stays that way.
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

/**
 * Prefix that runs `command` with `names` removed from its environment.
 *
 * Why this and not `clearEnvCommand` for a copied command: `clearEnvCommand`
 * mutates the *calling* shell, so it needs a shell-specific branch, and every
 * spelling of that branch touches `$fish_pid` — an unbound expansion that aborts
 * the whole line under `set -u`, taking the agent launch with it. This prefix
 * only has to change the CHILD's environment, which `env -u` does with no shell
 * syntax and no variable expansion at all. Verified identical in sh, bash, zsh,
 * dash, ksh and fish, including under `set -u`.
 */
export function withoutEnvCommand(
  names: readonly string[],
  command: string,
  shell: AgentStartupShell
): string {
  if (names.length === 0) {
    return command
  }
  if (isWindowsStartupShell(shell)) {
    // Windows has no `env -u`; those shells clear in-place, and neither has a
    // nounset mode that could abort the line.
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
