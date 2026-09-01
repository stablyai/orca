// Shell-independent v1 grammar for custom-agent args templates. One grammar
// serves every target shell so a stored template means the same argv on POSIX,
// PowerShell, WSL, and SSH; per-shell encoding happens later in the startup
// planner. Deliberately implemented fresh: `tokenizeCustomCommandTemplate` in
// commit-message-prompt.ts backslash-escapes any following character, which
// would corrupt Windows paths like C:\Users\me.
//
// Grammar:
// - Unquoted ASCII whitespace (space, tab, CR, LF) separates tokens; the
//   multiline editor is real — one or more arguments per line.
// - Single/double quotes group same-line text; a CR/LF inside either quote form
//   is invalid because not every target shell can represent it consistently.
// - Adjacent segments not separated by unquoted whitespace concatenate into one
//   token (`a"b"c` -> `abc`); a run of only empty quotes yields one empty token.
// - Outside quotes, backslash escapes only space, quote, or backslash; before
//   any other character it stays literal (preserves C:\Users\me). A trailing
//   literal backslash is valid. An escaped TAB/CR/LF is rejected so raw control
//   characters can never reach argv.
// - Inside double quotes only `\"` and `\\` decode; single-quoted content is
//   fully literal.
// - Shell operators, substitution, redirection, globs, and env expansion have
//   no special meaning — every token is data.

export type AgentArgsTokenizeFailureReason =
  | 'unterminated_quote'
  | 'quoted_line_break'
  | 'control_char'

export type AgentArgsTokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: AgentArgsTokenizeFailureReason; index: number }

const SEPARATORS = new Set([' ', '\t', '\r', '\n'])

function isDisallowedControl(char: string): boolean {
  const code = char.charCodeAt(0)
  // NUL, C0 (minus tab/CR/LF which are separators outside quotes), DEL, C1.
  if (code === 0x00 || code === 0x7f) {
    return true
  }
  if (code < 0x20) {
    return char !== '\t' && char !== '\r' && char !== '\n'
  }
  return code >= 0x80 && code <= 0x9f
}

export function tokenizeAgentArgsTemplate(template: string): AgentArgsTokenizeResult {
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let i = 0
  const length = template.length

  while (i < length) {
    const char = template[i]

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
      return { ok: false, reason: 'control_char', index: i }
    }

    if (char === "'") {
      const start = i
      i += 1
      hasCurrent = true
      while (i < length) {
        const inner = template[i]
        if (inner === "'") {
          break
        }
        if (inner === '\r' || inner === '\n') {
          return { ok: false, reason: 'quoted_line_break', index: i }
        }
        if (inner === '\t' || isDisallowedControl(inner)) {
          return { ok: false, reason: 'control_char', index: i }
        }
        current += inner
        i += 1
      }
      if (i >= length) {
        return { ok: false, reason: 'unterminated_quote', index: start }
      }
      i += 1
      continue
    }

    if (char === '"') {
      const start = i
      i += 1
      hasCurrent = true
      let closed = false
      while (i < length) {
        const inner = template[i]
        if (inner === '"') {
          closed = true
          i += 1
          break
        }
        if (inner === '\r' || inner === '\n') {
          return { ok: false, reason: 'quoted_line_break', index: i }
        }
        if (inner === '\t' || isDisallowedControl(inner)) {
          return { ok: false, reason: 'control_char', index: i }
        }
        if (inner === '\\' && i + 1 < length) {
          const next = template[i + 1]
          if (next === '"' || next === '\\') {
            current += next
            i += 2
            continue
          }
        }
        current += inner
        i += 1
      }
      if (!closed) {
        return { ok: false, reason: 'unterminated_quote', index: start }
      }
      continue
    }

    if (char === '\\') {
      const next = i + 1 < length ? template[i + 1] : null
      // Escaping TAB/CR/LF would smuggle raw control chars into argv; reject
      // them like the quoted forms do.
      if (next === '\t' || next === '\r' || next === '\n') {
        return { ok: false, reason: 'control_char', index: i + 1 }
      }
      if (next !== null && (next === ' ' || next === '"' || next === "'" || next === '\\')) {
        current += next
        hasCurrent = true
        i += 2
        continue
      }
      // Literal backslash (including a trailing one): preserves Windows paths.
      current += char
      hasCurrent = true
      i += 1
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

export type AgentArgsValidationResult =
  | { ok: true }
  | { ok: false; reason: AgentArgsTokenizeFailureReason; index: number }

export function validateAgentArgsTemplate(template: string): AgentArgsValidationResult {
  const result = tokenizeAgentArgsTemplate(template)
  if (!result.ok) {
    return { ok: false, reason: result.reason, index: result.index }
  }
  return { ok: true }
}

/** CRLF/CR normalize to LF only on an explicit save; reads never rewrite. */
export function canonicalizeAgentArgsLineEndings(template: string): string {
  return template.replace(/\r\n?/g, '\n')
}

const BARE_TOKEN_SAFE_RE = /^[^\s"'\\]+$/u

/** Canonical v1 serialization of an argv token list: bare where possible, else a
 *  double-quoted form using only the `\"` / `\\` escapes the grammar decodes. */
export function serializeAgentArgsTokens(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      if (token.length === 0) {
        return '""'
      }
      if (BARE_TOKEN_SAFE_RE.test(token)) {
        return token
      }
      return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    })
    .join(' ')
}
