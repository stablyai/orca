// Share single-line previews and multiline bodies with surrogate-safe cuts; agent-status-types.ts owns payload shapes and caps.

import { compactDispatchPromptForStatus } from './orca-dispatch-status-prompt'

/** Maximum character length for the prompt field. Truncated on parse. */
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200
/** Maximum character length for the toolInput preview. */
export const AGENT_STATUS_TOOL_INPUT_MAX_LENGTH = 160
/** Maximum character length for the agentType label. Truncated on parse. */
export const AGENT_TYPE_MAX_LENGTH = 40
export const AGENT_MODEL_MAX_LENGTH = 120

const SINGLE_LINE_FIELD_SCAN_OVERHEAD = 64
const SINGLE_LINE_FIELD_SCAN_MULTIPLIER = 8

// Drop high surrogates stranded by a cut so preview/body paths cannot render a replacement glyph.
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
  return (
    compactDispatchPromptForStatus(
      value,
      AGENT_STATUS_MAX_FIELD_LENGTH,
      normalizeSingleLinePreview
    ) ?? normalizeSingleLinePreview(value, AGENT_STATUS_MAX_FIELD_LENGTH)
  )
}

function normalizeSingleLinePreview(value: string, maxLength: number): string {
  // Bound source scans before folding previews so paste-sized text cannot force full regex passes for a short label.
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

// Preserve pre-wrap paragraph structure; normalize CRLF and cap paragraph gaps at one blank line.
function normalizeMultilineField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  // Fold U+2028/U+2029 before capping blank lines: pre-wrap renders them as breaks, otherwise paragraph-separator runs bypass the cap. Order: CRLF, bare CR, Unicode separators, blank-line collapse.
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

// Only provided strings update optional fields; absence must not erase cached state. Preserve option labels and shorten presentation fields only.
const COMPACTABLE_INTERACTIVE_PROMPT_FIELDS = new Set([
  'description',
  'detail',
  'header',
  'question',
  'summary'
])

function compactInteractivePromptValue(value: unknown, maxStringLength: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactInteractivePromptValue(item, maxStringLength))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'string' && COMPACTABLE_INTERACTIVE_PROMPT_FIELDS.has(key)
        ? truncatePreservingSurrogates(item, maxStringLength)
        : compactInteractivePromptValue(item, maxStringLength)
    ])
  )
}

/** Find the longest accepted prompt; JSON keeps structure/option labels by shortening presentation text only, while other text is cut. */
export function fitInteractivePrompt(
  prompt: string,
  fits: (candidate: string) => boolean
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(prompt)
  } catch {
    parsed = undefined
  }
  const promptAtLimit = (limit: number): string =>
    parsed === undefined
      ? truncatePreservingSurrogates(prompt, limit)
      : JSON.stringify(compactInteractivePromptValue(parsed, limit))
  let low = 1
  let high = prompt.length
  let fitted: string | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = promptAtLimit(mid)
    if (fits(candidate)) {
      fitted = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return fitted
}

// Preserve interactivePrompt JSON and option text verbatim; trimming/folding would corrupt structured cards. Empty strings become undefined.
export function normalizeInteractivePromptField(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  if (value.length <= maxLength) {
    return value
  }
  const fitted = fitInteractivePrompt(value, (candidate) => candidate.length <= maxLength)
  if (fitted !== null) {
    return fitted
  }
  // Why: labels alone over the cap keep the plain cut; readers treat unparseable JSON as capped.
  console.warn(
    `[agent-status] interactivePrompt of ${value.length} chars cannot fit ${maxLength} with its option labels; no card will show`
  )
  return truncatePreservingSurrogates(value, maxLength)
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

/** Keep a lead turn's end time only on the gated `working` row and that turn's later all-clear `done`. */
export function normalizeTurnCompletedAtField(value: unknown, state: string): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return state === 'working' || state === 'done' ? value : undefined
}
