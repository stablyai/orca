// Why: keeping the base prompt and assembly here (in shared) lets both the
// renderer (preview/tests) and main (actual generation) reach the exact same
// string without duplicating the wording.

export const COMMIT_MESSAGE_BASE_PROMPT = `You are generating a single git commit message.
Read the staged diff below and produce the message.

Rules:
- First line: imperative mood, <= 72 chars, no trailing period.
- Optional body: blank line, then wrapped at 72 chars explaining WHY.
- Output ONLY the commit message - no preamble, no code fences, no quotes.
- Do not include "Co-authored-by" trailers - Orca appends them after generation when configured.

Staged diff:
\`\`\`diff
{{DIFF}}
\`\`\`
`

/** Builds the final prompt sent to the agent. The custom suffix is appended verbatim
 *  when non-empty so the user can override style (Conventional Commits, gitmoji, …). */
export function buildCommitPrompt(diff: string, customSuffix: string): string {
  const base = COMMIT_MESSAGE_BASE_PROMPT.replace('{{DIFF}}', diff)
  const trimmedSuffix = customSuffix.trim()
  if (!trimmedSuffix) {
    return base
  }
  return `${base}\n\nAdditional instructions from user:\n${trimmedSuffix}`
}

export const STAGED_DIFF_BYTE_BUDGET = 200_000

/** Truncates a diff that exceeds the byte budget; appends a marker so the agent
 *  knows the input was clipped. */
export function truncateDiffForPrompt(
  diff: string,
  budget: number = STAGED_DIFF_BYTE_BUDGET
): string {
  if (diff.length <= budget) {
    return diff
  }
  const omitted = diff.length - budget
  return `${diff.slice(0, budget)}\n...(diff truncated, ${omitted} bytes omitted)`
}

/** Strips noise around the agent's output: surrounding whitespace, a single
 *  enclosing fenced code block, and lone "Generating…" preamble lines some
 *  CLIs print before the real answer. */
export function cleanGeneratedCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()

  // Why: real commit messages never start with an ellipsis or the word
  // "Generating"/"Thinking" — those leak from CLIs that print a status line
  // before the actual response.
  const firstNewline = text.indexOf('\n')
  if (firstNewline !== -1) {
    const firstLine = text.slice(0, firstNewline)
    if (/^(generating|thinking)\b/i.test(firstLine) || /^[.…]+$/.test(firstLine.trim())) {
      text = text.slice(firstNewline + 1).trim()
    }
  }

  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/
  const fenced = text.match(fence)
  if (fenced) {
    text = fenced[1].trim()
  }

  return text
}

export const CUSTOM_PROMPT_PLACEHOLDER = '{prompt}'

export type TokenizeCustomCommandResult =
  | { ok: true; tokens: string[] }
  | { ok: false; error: string }

// Why: deliberately POSIX-shell-style only for *grouping* (single + double
// quotes, backslash escapes inside double quotes). We do NOT expand `$VAR`,
// command substitution, backticks, globs, or `~`. The user's intent is
// "spawn this exact CLI" — adding shell semantics on top would create
// surprising behavior across platforms (especially Windows) and a security
// surface we don't need.
export function tokenizeCustomCommandTemplate(template: string): TokenizeCustomCommandResult {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < template.length) {
    const ch = template[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < template.length) {
        current += template[i + 1]
        i += 2
        continue
      }
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
      inToken = true
      i++
      continue
    }

    if (ch === '\\' && i + 1 < template.length) {
      current += template[i + 1]
      inToken = true
      i += 2
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
export function planCustomCommand(template: string, prompt: string): CustomCommandPlan {
  const tokenized = tokenizeCustomCommandTemplate(template)
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

// Why: agent CLIs (Codex, Claude) prefix their stdout/stderr with config
// preamble, the echoed prompt, and hook lifecycle messages. When something
// fails, the actionable error is buried far below all of that. This pulls
// out the real message so the user sees something legible instead of a
// dump of the agent's runtime state.
export function extractAgentErrorMessage(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`
  const lines = combined.split(/\r?\n/)

  // Pass 1: look for an `ERROR:`/`Error:` line carrying a JSON payload.
  // Walk from the end so the most recent (and usually most meaningful)
  // error wins when an agent prints multiple.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const match = /^\s*(?:ERROR|Error)\s*:\s*(.+)$/.exec(line)
    if (!match) {
      continue
    }
    const payload = match[1].trim()
    if (payload.startsWith('{')) {
      try {
        const parsed = JSON.parse(payload) as {
          message?: string
          error?: { message?: string }
        }
        const inner = parsed.error?.message ?? parsed.message
        if (typeof inner === 'string' && inner.trim().length > 0) {
          return inner.trim()
        }
      } catch {
        // Fall through to using the raw payload below.
      }
    }
    if (payload.length > 0) {
      return payload
    }
  }

  return null
}
