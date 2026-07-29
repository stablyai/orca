// ─── Agent status field normalization ───────────────────────────────────────
// String normalizers shared by every agent-status payload field: trim/fold to
// a single line for previews, preserve structure for multiline bodies, and
// truncate without splitting surrogate pairs. Extracted from
// agent-status-types.ts, which owns the payload shapes and per-field caps.

import {
  compactDispatchPromptForStatus,
  isOrcaDispatchStatusPrompt
} from './orca-dispatch-status-prompt'

/** Maximum character length for the prompt field. Truncated on parse. */
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200

const SINGLE_LINE_FIELD_SCAN_OVERHEAD = 64
const SINGLE_LINE_FIELD_SCAN_MULTIPLIER = 8

// Why: when truncation lands mid surrogate-pair (emoji / astral chars), the
// high surrogate would be left dangling and render as the Unicode replacement
// glyph. Drop the lone high surrogate so the result is always a valid UTF-16
// sequence. Shared by the single-line and multiline normalizers so the
// protection can't drift between them.
function truncatePreservingSurrogates(value: string, maxLength: number): string {
  if (value.length < maxLength) {
    return value
  }
  let truncated = value.length === maxLength ? value : value.slice(0, maxLength)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1)
  }
  return truncated
}

/** Normalize a status field: trim, collapse to single line, truncate. */
function normalizeField(value: unknown, maxLength: number = AGENT_STATUS_MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string') {
    return ''
  }
  return normalizeSingleLinePreview(value, maxLength)
}

/** Normalize the agent prompt field, compacting Orca dispatch preambles. */
export function normalizePromptField(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  if (isOrcaDispatchStatusPrompt(value)) {
    return compactDispatchPromptForStatus(
      value,
      AGENT_STATUS_MAX_FIELD_LENGTH,
      normalizeSingleLinePreview
    )
  }
  return normalizeSingleLinePreview(value, AGENT_STATUS_MAX_FIELD_LENGTH)
}

function normalizeSingleLinePreview(value: string, maxLength: number): string {
  // Why: hook prompt/tool fields are previews. Bound the source scan before
  // folding line breaks so paste-sized status text cannot run a full regex
  // replacement just to keep a small dashboard label.
  const scanEnd = Math.min(
    value.length,
    maxLength * SINGLE_LINE_FIELD_SCAN_MULTIPLIER + SINGLE_LINE_FIELD_SCAN_OVERHEAD
  )
  let index = 0
  while (index < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(index))) {
    index++
  }

  let normalized = ''
  let lineSeparatorRun = false
  while (index < scanEnd && normalized.length < maxLength) {
    const code = value.charCodeAt(index)
    if (isSingleLineSeparator(code)) {
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index++
      }
      if (!lineSeparatorRun) {
        normalized += ' '
      }
      lineSeparatorRun = true
      index++
      continue
    }

    normalized += value[index]
    lineSeparatorRun = false
    index++
  }

  if (normalized.length < maxLength) {
    normalized = trimTrailingWhitespace(normalized)
  }
  return truncatePreservingSurrogates(normalized, maxLength)
}

// Why: assistant messages are a multi-paragraph "what did the agent say"
// body that the dashboard renders with `whitespace-pre-wrap`. Collapsing
// newlines here would erase structure the UI is designed to show. Still
// normalize `\r\n` → `\n` and cap paragraph gaps at one blank line to keep
// the bound meaningful, but otherwise preserve line breaks.
function normalizeMultilineField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  // Why: fold Unicode line/paragraph separators (U+2028, U+2029) into ordinary
  // `\n` before the blank-line-run cap. These code points render as real line
  // breaks under `whitespace-pre-wrap`, so leaving them untouched would let a
  // buggy/malicious agent bypass the `\n{3,}` → `\n\n` safeguard by spamming
  // arbitrarily many U+2029 paragraph breaks. Matches the single-line
  // normalizer's treatment of the same code points, keeping the two paths in
  // sync. Step order preserved: `\r\n` → `\n`, bare `\r` → `\n`,
  // U+2028/U+2029 → `\n`, then collapse blank-line runs.
  const { start, end } = getTrimmedStringBounds(value)
  let normalized = ''
  let newlineRun = 0
  for (let index = start; index < end && normalized.length < maxLength; index++) {
    const code = value.charCodeAt(index)
    if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index++
      }
      if (newlineRun < 2) {
        normalized += '\n'
      }
      newlineRun++
      continue
    }

    normalized += value[index]
    newlineRun = 0
  }
  return truncatePreservingSurrogates(normalized, maxLength)
}

function getTrimmedStringBounds(value: string): { start: number; end: number } {
  let start = 0
  let end = value.length
  while (start < end && isEcmaTrimWhitespace(value.charCodeAt(start))) {
    start++
  }
  while (end > start && isEcmaTrimWhitespace(value.charCodeAt(end - 1))) {
    end--
  }
  return { start, end }
}

function trimTrailingWhitespace(value: string): string {
  let end = value.length
  while (end > 0 && isEcmaTrimWhitespace(value.charCodeAt(end - 1))) {
    end--
  }
  return end === value.length ? value : value.slice(0, end)
}

function isSingleLineSeparator(code: number): boolean {
  return code === 13 || code === 10 || code === 0x2028 || code === 0x2029
}

function isEcmaTrimWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

// Why: tool/assistant fields are optional on the entry (absence = "no update
// for this field"). We only surface them when the caller actually provided a
// string value so a missing field doesn't overwrite the prior cached state.
// Why: interactivePrompt carries raw JSON (`{ questions: [...] }`) that clients
// JSON.parse to render a structured card. Unlike the other normalizers we must
// NOT trim, collapse newlines, or fold blank-line runs — any of those would
// corrupt the JSON or alter option text inside it. Only guard the length cap
// (preserving surrogate pairs) and drop empty strings to undefined.
export function normalizeInteractivePromptField(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const truncated = truncatePreservingSurrogates(value, maxLength)
  return truncated.length > 0 ? truncated : undefined
}

export function normalizeOptionalField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

export function normalizeOptionalMultilineField(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeMultilineField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}
