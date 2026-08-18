// Why: keeping the base prompt and assembly here (in shared) lets both the
// renderer (preview/tests) and main (actual generation) reach the exact same
// string without duplicating the wording.

const COMMIT_MESSAGE_BASE_PROMPT = `You are generating a single git commit message.
Read the staged diff below and produce the message.

Rules:
- First line: imperative mood, <= 72 chars, no trailing period.
- Optional body: blank line, then wrapped at 72 chars explaining WHY.
- Output ONLY the commit message - no preamble, no code fences, no quotes.
- Do not include "Co-authored-by" or other git trailers.

Staged diff:
\`\`\`diff
{{DIFF}}
\`\`\`
`

export {
  cleanGeneratedCommitMessage,
  excerptAgentFailureOutput
} from './commit-message-agent-output'

/** Builds the final prompt sent to the agent. The custom suffix is appended verbatim
 *  when non-empty so the user can override style (Conventional Commits, gitmoji, …). */
export function buildCommitPrompt(diff: string, customSuffix: string): string {
  const base = COMMIT_MESSAGE_BASE_PROMPT.replace('{{DIFF}}', diff)
  const trimmedSuffix = customSuffix.trim()
  if (!trimmedSuffix) {
    return base
  }
  return `${base}\n\nAdditional user prompt:\n${trimmedSuffix}`
}

export const STAGED_DIFF_BYTE_BUDGET = 200_000

/** Splits a unified diff into one section per file, keyed on the `diff --git`
 *  header. Each section keeps the leading newline that preceded its header so
 *  concatenating the sections reproduces the original byte-for-byte. */
function splitDiffIntoFileSections(diff: string): string[] {
  const boundary = '\ndiff --git '
  const sections: string[] = []
  let start = 0
  let next = diff.indexOf(boundary)
  while (next !== -1) {
    // Include the boundary newline in the current section; the next section
    // starts at the `diff --git` header itself.
    sections.push(diff.slice(start, next + 1))
    start = next + 1
    next = diff.indexOf(boundary, start)
  }
  sections.push(diff.slice(start))
  return sections
}

/** Clips one section to `limit` bytes on a line boundary so the agent never sees
 *  a half-written diff line, and records how many bytes were dropped. */
function clipSectionOnLineBoundary(section: string, limit: number): string {
  if (section.length <= limit) {
    return section
  }
  if (limit <= 0) {
    return ''
  }

  const markerFor = (omitted: number): string => `\n...(diff truncated, ${omitted} bytes omitted)\n`
  let marker = markerFor(section.length)
  if (marker.length >= limit) {
    return marker.slice(0, limit)
  }

  // Reserve headroom for the marker, then back up to the previous newline unless
  // that would discard most of the budget (one very long line).
  const target = limit - marker.length
  const lineBreak = section.lastIndexOf('\n', target)
  const cut = lineBreak > target / 2 ? lineBreak : target
  const omitted = section.length - cut
  marker = markerFor(omitted)
  return `${section.slice(0, Math.min(cut, Math.max(0, limit - marker.length)))}${marker}`
}

/** Distributes `budget` across `sizes` by water-filling: everyone starts with an
 *  equal share, and the slack from files that fit is handed back to the files
 *  that don't. Keeps one huge generated file from starving the human-authored
 *  changes elsewhere in the diff. */
function allocateBudgetFairly(sizes: number[], budget: number): number[] {
  const alloc: number[] = Array.from({ length: sizes.length }, () => 0)
  let active = sizes.map((_, i) => i)
  let remaining = budget
  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length)
    if (share === 0) {
      break
    }
    const stillActive: number[] = []
    for (const i of active) {
      const need = sizes[i] - alloc[i]
      const grant = Math.min(need, share)
      alloc[i] += grant
      remaining -= grant
      if (grant < need) {
        stillActive.push(i)
      }
    }
    active = stillActive
  }
  return alloc
}

/** Truncates a diff that exceeds the byte budget. Splits the budget fairly across
 *  files and clips on line boundaries, so a single oversized file can't crowd out
 *  the rest and the agent never receives a malformed diff. */
export function truncateDiffForPrompt(
  diff: string,
  budget: number = STAGED_DIFF_BYTE_BUDGET
): string {
  if (diff.length <= budget) {
    return diff
  }
  const sections = splitDiffIntoFileSections(diff)
  if (sections.length <= 1) {
    return clipSectionOnLineBoundary(diff, budget)
  }
  const allocations = allocateBudgetFairly(
    sections.map((section) => section.length),
    budget
  )
  return sections.map((section, i) => clipSectionOnLineBoundary(section, allocations[i])).join('')
}

export const CUSTOM_PROMPT_PLACEHOLDER = '{prompt}'

/** Source range of a token: [start, end) offsets into the original string.
 * `divergesFromShell` marks a token this tokenizer cannot model faithfully for
 * the target shell: an unquoted operator (`;&|<>`), a word-leading `#`
 * comment, an expansion opener whose body can span tokens (backtick, `$(`,
 * `${`, quoted or not), or a cmd single-quoted region (cmd has no
 * single-quote syntax). Not recoverable from the token value alone. */
export type CommandTokenSpan = { start: number; end: number; divergesFromShell: boolean }

export type TokenizeCustomCommandResult =
  | { ok: true; tokens: string[]; spans: CommandTokenSpan[] }
  | { ok: false; error: string }

// Why: deliberately POSIX-shell-style only for *grouping* (single + double
// quotes, backslash escapes inside double quotes). We do NOT expand `$VAR`,
// command substitution, backticks, globs, or `~`. The user's intent is
// "spawn this exact CLI" — adding shell semantics on top would create
// surprising behavior across platforms (especially Windows) and a security
// surface we don't need.
/**
 * `'escape'` (default) is POSIX: a backslash quotes the next byte, so `foo\ bar`
 * is one token. `'literal'` is for a command that will run on native Windows,
 * where `\` is the path separator — eating it turns
 * `C:\Windows\System32\powershell.exe` into `C:WindowsSystem32powershell.exe`,
 * a path that then "cannot be found" (#11375).
 *
 * Opt-in rather than sniffed from `process.platform` here, because the same
 * template can be parsed on one host and executed on another.
 */
export type CommandTemplateBackslash = 'escape' | 'literal'

export function tokenizeCustomCommandTemplate(
  template: string,
  backslash: CommandTemplateBackslash = 'escape'
): TokenizeCustomCommandResult {
  const backslashEscapes = backslash === 'escape'
  const tokens: string[] = []
  const spans: CommandTokenSpan[] = []
  let current = ''
  let inToken = false
  let tokenStart = 0
  let divergesFromShell = false
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < template.length) {
    const ch = template[i]
    if (quote) {
      if (backslashEscapes && ch === '\\' && quote === '"' && i + 1 < template.length) {
        // Why: inside double quotes the shell only consumes the backslash
        // before these; elsewhere it stays a literal byte this tokenizer drops.
        divergesFromShell ||= !'$`"\\'.includes(template[i + 1])
        current += template[i + 1]
        i += 2
        continue
      }
      // Why: a `"` inside $(…) or `…` re-opens a nested quoting context in the
      // real shell, so this tokenizer's word boundaries stop matching it.
      divergesFromShell ||=
        quote === '"' && (ch === '`' || (ch === '$' && '({'.includes(template[i + 1] ?? '\0')))
      if (ch === quote) {
        quote = null
        i++
        // Why: leaving a quoted region still keeps the token open — `a"b"c`
        // tokenizes as a single arg `abc`.
        inToken = true
        continue
      }
      current += ch
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      if (!inToken) {
        tokenStart = i
      }
      inToken = true
      i++
      continue
    }

    if (backslashEscapes && ch === '\\' && i + 1 < template.length) {
      // Why: an unquoted line continuation joins words the shell splits, so a
      // selector can hide inside the joined token and skip the gap check.
      divergesFromShell ||= template[i + 1] === '\n'
      current += template[i + 1]
      if (!inToken) {
        tokenStart = i
      }
      inToken = true
      i += 2
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        spans.push({ start: tokenStart, end: i, divergesFromShell })
        current = ''
        inToken = false
        divergesFromShell = false
      }
      i++
      continue
    }

    if (!inToken) {
      tokenStart = i
    }
    // Why: a trailing unpaired escape swallows whatever a consumer appends
    // after the base, so the base is not safe to build on.
    divergesFromShell ||= backslashEscapes && ch === '\\' && i + 1 >= template.length
    divergesFromShell ||=
      ';&|<>`'.includes(ch) ||
      (ch === '#' && !inToken) ||
      (ch === '$' && '({\'"'.includes(template[i + 1] ?? '\0'))
    current += ch
    inToken = true
    i++
  }

  if (quote) {
    return { ok: false, error: 'Unclosed quote in command template.' }
  }
  if (inToken) {
    tokens.push(current)
    spans.push({ start: tokenStart, end: template.length, divergesFromShell })
  }
  return { ok: true, tokens, spans }
}

export type CustomCommandPlan =
  | { ok: true; binary: string; args: string[]; stdinPayload: string | null }
  | { ok: false; error: string }

/**
 * Parses a user-supplied command template into a spawn-ready binary + argv,
 * substituting `{prompt}` with the agent prompt. When the template contains
 * no `{prompt}`, the prompt is delivered via stdin (mirrors `claude -p`).
 *
 * Quoting is a tokenizer-level concern only — we use argv (no shell), so the
 * substituted prompt is always passed as a single argument regardless of
 * whether the template wrote `{prompt}` or `"{prompt}"`.
 */
export function planCustomCommand(
  template: string,
  prompt: string,
  backslash: CommandTemplateBackslash = 'escape'
): CustomCommandPlan {
  const tokenized = tokenizeCustomCommandTemplate(template, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: tokenized.error }
  }
  if (tokenized.tokens.length === 0) {
    return { ok: false, error: 'Custom command is empty.' }
  }
  const [binary, ...rest] = tokenized.tokens
  if (!binary) {
    return { ok: false, error: 'Custom command must start with a binary name.' }
  }

  const substitute = (token: string): string =>
    token.includes(CUSTOM_PROMPT_PLACEHOLDER)
      ? token.split(CUSTOM_PROMPT_PLACEHOLDER).join(prompt)
      : token
  const usesPlaceholder = tokenized.tokens.some((t) => t.includes(CUSTOM_PROMPT_PLACEHOLDER))
  if (usesPlaceholder) {
    return {
      ok: true,
      binary: substitute(binary),
      args: rest.map(substitute),
      stdinPayload: null
    }
  }
  return { ok: true, binary, args: rest, stdinPayload: prompt }
}
