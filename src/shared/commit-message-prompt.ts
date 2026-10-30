import { extractLeadingEnvAssignments } from './command-environment'
// Share prompt wording between renderer preview/tests and main generation.

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
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail,
  stripPrefilledReasoningPreamble
} from './commit-message-agent-output'

/** Append custom suffix verbatim so user style instructions can override defaults. */
export function buildCommitPrompt(diff: string, customSuffix: string): string {
  const base = COMMIT_MESSAGE_BASE_PROMPT.replace('{{DIFF}}', diff)
  const trimmedSuffix = customSuffix.trim()
  if (!trimmedSuffix) {
    return base
  }
  return `${base}\n\nAdditional user prompt:\n${trimmedSuffix}`
}

export const STAGED_DIFF_BYTE_BUDGET = 200_000

/** Split at diff --git headers while retaining boundary newlines so concatenation exactly reproduces input. */
function splitDiffIntoFileSections(diff: string): string[] {
  const boundary = '\ndiff --git '
  const sections: string[] = []
  let start = 0
  let next = diff.indexOf(boundary)
  while (next !== -1) {
    // Assign the boundary newline to the preceding section; the next begins with its header.
    sections.push(diff.slice(start, next + 1))
    start = next + 1
    next = diff.indexOf(boundary, start)
  }
  sections.push(diff.slice(start))
  return sections
}

/** Clip to a UTF-16 budget, preferring whole lines unless one would consume most of the allowance; include an omission marker. */
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

/** Redistribute unused per-file shares so one huge generated file cannot starve smaller human-authored changes. */
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

/** Share the UTF-16 budget across files and prefer line boundaries; an oversized file cannot crowd out the others. */
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

/** Original [start,end) offsets. divergesFromShell marks operators, leading #, expansion openers spanning tokens, or cmd single quotes; token values alone cannot recover these hazards. */
export type CommandTokenSpan = { start: number; end: number; divergesFromShell: boolean }

export type TokenizeCustomCommandResult =
  | { ok: true; tokens: string[]; spans: CommandTokenSpan[] }
  | { ok: false; error: string }

// Group POSIX-style quotes/escapes only; never expand variables, substitutions, globs or home paths. Spawn exact argv without cross-platform shell semantics.
/** Default escape consumes the next character; literal preserves native-Windows path separators (#11375). Select by execution target, not process.platform, because parsing and execution may happen on different hosts. */
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
        // Shell double quotes consume escapes only before these characters; other escapes diverge from this tokenizer.
        divergesFromShell ||= !'$`"\\'.includes(template[i + 1])
        current += template[i + 1]
        i += 2
        continue
      }
      // Expansion bodies can reopen nested shell quotes, invalidating tokenizer word boundaries.
      divergesFromShell ||=
        quote === '"' && (ch === '`' || (ch === '$' && '({'.includes(template[i + 1] ?? '\0')))
      if (ch === quote) {
        quote = null
        i++
        // Adjacent quoted/unquoted pieces form one token (a"b"c becomes abc).
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
      // Unquoted continuation joins words the shell splits, potentially hiding a selector from gap checks.
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
    // An unpaired trailing escape would swallow appended content; reject the base as unsafe to extend.
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
  | {
      ok: true
      binary: string
      args: string[]
      stdinPayload: string | null
      env?: Record<string, string>
    }
  | { ok: false; error: string }

/** Substitute prompt as one argv value regardless of placeholder quoting; without a placeholder send it on stdin. Tokenization groups only, with no shell. */
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
  const { env, rest: commandTokens } = extractLeadingEnvAssignments(tokenized.tokens)
  const [binary, ...rest] = commandTokens
  if (!binary) {
    return { ok: false, error: 'Custom command must start with a binary name.' }
  }

  const substitute = (token: string): string =>
    token.includes(CUSTOM_PROMPT_PLACEHOLDER)
      ? token.split(CUSTOM_PROMPT_PLACEHOLDER).join(prompt)
      : token
  const usesPlaceholder = commandTokens.some((t) => t.includes(CUSTOM_PROMPT_PLACEHOLDER))
  if (usesPlaceholder) {
    return {
      ok: true,
      binary: substitute(binary),
      args: rest.map(substitute),
      stdinPayload: null,
      ...(env ? { env } : {})
    }
  }
  return { ok: true, binary, args: rest, stdinPayload: prompt, ...(env ? { env } : {}) }
}
