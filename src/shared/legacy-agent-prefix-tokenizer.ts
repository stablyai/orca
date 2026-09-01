// Read adapter for the legacy built-in command-prefix override (settings
// `agentCmdOverrides` values). At HEAD nothing tokenizes this raw string:
// `resolveBaseCommand` in tui-agent-startup.ts concatenates it as shell text and
// the target shell splits it. This adapter reproduces each installed override's
// CURRENT per-target-shell meaning so launch and the built-in duplication
// equivalence gate can read it as structured argv instead of raw text.
//
// Per-shell grammar (grouping only — no expansion, substitution, or globbing):
// - posix: whitespace splits; single quotes literal-group; double quotes group
//   with `\" \\ \$ \`` backslash escapes; backslash outside quotes escapes the
//   next char.
// - powershell: whitespace splits with double- AND single-quote grouping;
//   backslashes are literal; the U+2018-U+201B smart-quote class groups like ';
//   backtick escapes the next char outside quotes and `` `" `` / ``` `` ``` /
//   `` `$ `` inside double quotes (never inside single quotes); doubling a
//   delimiter inside its own group (`''`, `""`) is one literal delimiter.
// - cmd: whitespace splits with double-quote grouping only; backslashes literal;
//   single quotes are ordinary characters; caret escapes the next char OUTSIDE
//   quotes only — inside double quotes a caret is a literal character.
// All shells reject NUL/control chars and unquoted shell operators so these
// overrides stay visible for Settings repair rather than being reinterpreted.

import type { AgentStartupShell } from './tui-agent-startup-shell'

export type LegacyAgentPrefixTokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: 'unterminated_quote' | 'shell_operator' | 'control_char' }

const SEPARATORS = new Set([' ', '\t', '\r', '\n'])

// Unquoted occurrences of these route the override to Settings repair rather
// than being executed or split (launch maps this to invalid_command_override).
const OPERATOR_CHARS = new Set(['&', '|', ';', '<', '>'])

// PowerShell groups the ASCII apostrophe and the U+2018-U+201B smart-quote class
// as one interchangeable single-quote delimiter class.
const POWERSHELL_SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛'])

function isDisallowedControl(char: string): boolean {
  const code = char.charCodeAt(0)
  // NUL, C0 (minus tab/CR/LF which act as separators), DEL, C1.
  if (code === 0x00 || code === 0x7f) {
    return true
  }
  if (code < 0x20) {
    return char !== '\t' && char !== '\r' && char !== '\n'
  }
  return code >= 0x80 && code <= 0x9f
}

type QuoteScan =
  | { ok: true; value: string; nextIndex: number }
  | { ok: false; reason: 'unterminated_quote' | 'control_char' }

/** Literal-group scan until any closing delimiter in `closers`. The only escape
 *  is `doubledDelimiter`: a closer immediately followed by another closer is one
 *  literal delimiter, not close-then-reopen (PowerShell's own `''` form). */
function scanLiteralQuote(
  input: string,
  openIndex: number,
  closers: Set<string>,
  doubledDelimiter: boolean
): QuoteScan {
  let value = ''
  let i = openIndex + 1
  while (i < input.length) {
    const inner = input[i]
    if (closers.has(inner)) {
      if (doubledDelimiter && i + 1 < input.length && closers.has(input[i + 1])) {
        // The scanned char is kept, matching what quoteStartupArg emits (each
        // delimiter doubled with itself); PowerShell's quote class is
        // interchangeable, so a mixed pair still escapes.
        value += inner
        i += 2
        continue
      }
      return { ok: true, value, nextIndex: i + 1 }
    }
    if (isDisallowedControl(inner)) {
      return { ok: false, reason: 'control_char' }
    }
    value += inner
    i += 1
  }
  return { ok: false, reason: 'unterminated_quote' }
}

/** Double-quote scan where `escape` drops before one of `escapable`; any other
 *  occurrence stays literal alongside the following character. `doubledDelimiter`
 *  additionally reads `""` as one literal quote (PowerShell's second escape form,
 *  which the backtick escape does not replace). */
function scanEscapableDoubleQuote(
  input: string,
  openIndex: number,
  escape: string,
  escapable: Set<string>,
  doubledDelimiter: boolean
): QuoteScan {
  let value = ''
  let i = openIndex + 1
  while (i < input.length) {
    const inner = input[i]
    if (inner === '"') {
      if (doubledDelimiter && input[i + 1] === '"') {
        value += '"'
        i += 2
        continue
      }
      return { ok: true, value, nextIndex: i + 1 }
    }
    if (isDisallowedControl(inner)) {
      return { ok: false, reason: 'control_char' }
    }
    if (inner === escape && i + 1 < input.length) {
      const next = input[i + 1]
      if (escapable.has(next)) {
        value += next
        i += 2
        continue
      }
    }
    value += inner
    i += 1
  }
  return { ok: false, reason: 'unterminated_quote' }
}

type ShellGrammar = {
  /** Chars that open a literal single-quote group, mapped to their closer set. */
  singleQuoteOpeners: Map<string, Set<string>>
  /** Escape char decoded inside double quotes, with the chars it drops before.
   *  Null when double quotes are a literal group (cmd). */
  doubleQuoteEscape: { char: string; escapable: Set<string> } | null
  /** Outside quotes, this char escapes the next one: posix `\`, powershell
   *  backtick, cmd caret. */
  escapeOutsideQuotes: string | null
  /** True when doubling a quote delimiter inside its own group yields one
   *  literal delimiter (`''` / `""`). PowerShell only; posix and cmd read the
   *  second delimiter as reopening a new group. */
  doubledDelimiterEscape: boolean
}

const DOUBLE_QUOTE_CLOSERS = new Set(['"'])

function grammarFor(shell: AgentStartupShell): ShellGrammar {
  if (shell === 'posix') {
    return {
      singleQuoteOpeners: new Map([["'", new Set(["'"])]]),
      doubleQuoteEscape: { char: '\\', escapable: new Set(['"', '\\', '$', '`']) },
      escapeOutsideQuotes: '\\',
      doubledDelimiterEscape: false
    }
  }
  if (shell === 'powershell') {
    const openers = new Map<string, Set<string>>()
    for (const opener of POWERSHELL_SINGLE_QUOTES) {
      openers.set(opener, POWERSHELL_SINGLE_QUOTES)
    }
    return {
      singleQuoteOpeners: openers,
      doubleQuoteEscape: { char: '`', escapable: new Set(['"', '`', '$']) },
      escapeOutsideQuotes: '`',
      doubledDelimiterEscape: true
    }
  }
  // cmd: double-quote grouping only; single quotes and backslashes are literal,
  // and the caret escape is suppressed inside quotes.
  return {
    singleQuoteOpeners: new Map(),
    doubleQuoteEscape: null,
    escapeOutsideQuotes: '^',
    doubledDelimiterEscape: false
  }
}

export function tokenizeLegacyAgentPrefix(
  prefix: string,
  shell: AgentStartupShell
): LegacyAgentPrefixTokenizeResult {
  const grammar = grammarFor(shell)
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let i = 0

  while (i < prefix.length) {
    const char = prefix[i]

    if (SEPARATORS.has(char)) {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      i += 1
      continue
    }

    if (isDisallowedControl(char)) {
      return { ok: false, reason: 'control_char' }
    }

    if (OPERATOR_CHARS.has(char)) {
      return { ok: false, reason: 'shell_operator' }
    }

    if (char === '"') {
      const escape = grammar.doubleQuoteEscape
      const scan = escape
        ? scanEscapableDoubleQuote(
            prefix,
            i,
            escape.char,
            escape.escapable,
            grammar.doubledDelimiterEscape
          )
        : scanLiteralQuote(prefix, i, DOUBLE_QUOTE_CLOSERS, grammar.doubledDelimiterEscape)
      if (!scan.ok) {
        return scan
      }
      current += scan.value
      hasCurrent = true
      i = scan.nextIndex
      continue
    }

    const singleCloser = grammar.singleQuoteOpeners.get(char)
    if (singleCloser) {
      const scan = scanLiteralQuote(prefix, i, singleCloser, grammar.doubledDelimiterEscape)
      if (!scan.ok) {
        return scan
      }
      current += scan.value
      hasCurrent = true
      i = scan.nextIndex
      continue
    }

    if (char === grammar.escapeOutsideQuotes && i + 1 < prefix.length) {
      const next = prefix[i + 1]
      if (isDisallowedControl(next)) {
        return { ok: false, reason: 'control_char' }
      }
      current += next
      hasCurrent = true
      i += 2
      continue
    }

    current += char
    hasCurrent = true
    i += 1
  }

  if (hasCurrent) {
    tokens.push(current)
  }
  return { ok: true, tokens }
}

const ALL_SHELLS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

function tokensEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((token, index) => token === b[index])
}

// Characters no shell grammar reinterprets, so a token made only of them needs
// no quoting. Anything else is double-quoted, which groups on all three shells.
const UNQUOTED_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./~-]+$/

/** Inverse of {@link tokenizeLegacyAgentPrefix}: renders argv back to an args
 *  string that re-tokenizes to exactly these tokens under EVERY shell grammar,
 *  so quoted boundaries survive the round trip (a plain `join(' ')` re-splits a
 *  grouped token). Null when a token cannot be rendered that way — the caller
 *  reports it as platform-ambiguous rather than emitting a lossy string. */
export function formatLegacyAgentPrefixArgs(tokens: readonly string[]): string | null {
  if (tokens.length === 0) {
    return ''
  }
  const rendered = tokens
    .map((token) => (UNQUOTED_TOKEN_RE.test(token) ? token : `"${token}"`))
    .join(' ')
  const roundTrips = ALL_SHELLS.every((shell) => {
    const result = tokenizeLegacyAgentPrefix(rendered, shell)
    return result.ok && tokensEqual(result.tokens, tokens)
  })
  return roundTrips ? rendered : null
}

/** True when the prefix does not read to identical argv under all three shell
 *  grammars — the built-in duplication equivalence gate. Uniform failures (same
 *  reason under every grammar) are not ambiguous; the caller's tokenize catches
 *  them. Any ok/error mix or divergent argv is ambiguous. */
export function isLegacyAgentPrefixPlatformAmbiguous(prefix: string): boolean {
  const results = ALL_SHELLS.map((shell) => tokenizeLegacyAgentPrefix(prefix, shell))
  const [first, ...rest] = results
  if (first.ok) {
    return !rest.every((other) => other.ok && tokensEqual(first.tokens, other.tokens))
  }
  return !rest.every((other) => !other.ok && other.reason === first.reason)
}
