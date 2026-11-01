/** jcode's `run --json` envelope, narrowed to the field the answer lives in. */
type JcodeJsonResult = { text?: unknown }

function isJcodeJsonResult(value: unknown): value is JcodeJsonResult {
  return typeof value === 'object' && value !== null && 'text' in value
}

/** Remove surrounding whitespace, one enclosing fence, CLI progress preambles and leading reasoning from generated answers. */
export function cleanGeneratedCommitMessage(raw: string): string {
  // Scan boundaries instead of allocating newline arrays for large generated bodies.
  let text = normalizeGeneratedCommitMessageLineFeeds(raw).trim()

  // Extract jcode --json text; plain mode mixes thinking and token-usage lines into stdout.
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isJcodeJsonResult(parsed) && typeof parsed.text === 'string') {
        text = parsed.text.trim()
      }
    } catch {
      // not a JSON envelope; fall through to the plain-text cleanup
    }
  }

  // Strip jcode’s trailing [Tokens] usage line before using the answer as a branch/commit name.
  const tokensUsageIndex = text.search(/\n\[Tokens\]\s/)
  if (tokensUsageIndex !== -1) {
    text = text.slice(0, tokensUsageIndex).trimEnd()
  }

  // Discard CLI progress preambles before the actual answer.
  const firstNewline = text.indexOf('\n')
  if (firstNewline !== -1) {
    const firstLine = text.slice(0, firstNewline)
    if (/^(generating|thinking)\b/i.test(firstLine) || /^[.\u2026]+$/.test(firstLine.trim())) {
      text = text.slice(firstNewline + 1).trim()
    }
  }

  text = stripLeadingReasoningBlock(text)

  const fenced = findEnclosingCommitMessageFenceBody(text)
  if (fenced !== null) {
    text = fenced.trim()
  }

  // Some CLIs ignore raw-text instructions and emit list markers; keep those out of Git subjects.
  text = text.replace(/^(\s*)(?:[-*\u2022\u25CF]\s+|\d+[.)]\s+)/, '$1').trim()

  return text
}

// DeepSeek-R1/Qwen3/Kimi K2 reasoning uses <think>; Kimi-VL-Thinking uses ◁think▷.
const REASONING_TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '◁think▷', close: '◁/think▷' }
] as const

function stripLeadingReasoningBlock(text: string): string {
  for (const { open, close } of REASONING_TAGS) {
    if (!text.startsWith(open)) {
      continue
    }
    const closeIndex = text.indexOf(close, open.length)
    return closeIndex === -1 ? text : text.slice(closeIndex + close.length).trim()
  }
  return text
}

/** Custom commands only: Qwen3-Thinking/DeepSeek-R1-0528/Kimi K2.5 may prefill the opening reasoning tag, emitting only its close. Other messages can legitimately mention closing tags. */
export function stripPrefilledReasoningPreamble(text: string): string {
  for (const { open, close } of REASONING_TAGS) {
    const closeIndex = text.indexOf(close)
    if (closeIndex !== -1 && text.lastIndexOf(open, closeIndex) === -1) {
      return text.slice(closeIndex + close.length).trim()
    }
  }
  return text
}

function normalizeGeneratedCommitMessageLineFeeds(value: string): string {
  let crlfStart = value.indexOf('\r\n')
  if (crlfStart === -1) {
    return value
  }

  let normalized = value.slice(0, crlfStart)
  let chunkStart = crlfStart + 2
  normalized += '\n'
  crlfStart = value.indexOf('\r\n', chunkStart)

  while (crlfStart !== -1) {
    normalized += value.slice(chunkStart, crlfStart)
    normalized += '\n'
    chunkStart = crlfStart + 2
    crlfStart = value.indexOf('\r\n', chunkStart)
  }

  return `${normalized}${value.slice(chunkStart)}`
}

function findEnclosingCommitMessageFenceBody(text: string): string | null {
  if (!text.startsWith('```')) {
    return null
  }

  let headerEnd = 3
  while (headerEnd < text.length && text.charCodeAt(headerEnd) !== 10) {
    if (!isCommitFenceInfoCharacter(text.charCodeAt(headerEnd))) {
      return null
    }
    headerEnd++
  }

  if (headerEnd >= text.length) {
    return null
  }

  const closingFenceStart = text.length - 3
  if (closingFenceStart <= headerEnd || !text.endsWith('```')) {
    return null
  }
  if (text.charCodeAt(closingFenceStart - 1) !== 10) {
    return null
  }

  return text.slice(headerEnd + 1, closingFenceStart - 1)
}

function isCommitFenceInfoCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  )
}

export function stripAnsiControlSequences(value: string): string {
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  // Raw CLI failures can contain both CSI colors/cursor and OSC titles/hyperlinks.
  return value.replace(
    new RegExp(
      `${esc}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${bel}${esc}\\r\\n]*(?:${bel}|${esc}\\\\))`,
      'g'
    ),
    ''
  )
}

function stripAnsiIfPresent(value: string): string {
  return value.includes(String.fromCharCode(27)) ? stripAnsiControlSequences(value) : value
}

// Bound scans to the output’s ends.
const FAILURE_EXCERPT_SCAN_WINDOW = 8192
const FAILURE_EXCERPT_HEAD_LINE_COUNT = 2
// Give the tail more space for typical final diagnostics; preserve head space for CLIs that front-load errors. Single excerpts use the full budget.
const FAILURE_EXCERPT_HEAD_BUDGET = 100
const FAILURE_EXCERPT_TAIL_BUDGET = 130
const FAILURE_EXCERPT_SINGLE_BUDGET = 240

// CLI error formats drift; excerpt first/last lines without interpreting vendor wording. Callers must sanitize before display/persistence.
export function excerptAgentFailureOutput(stdout: string, stderr: string): string | null {
  // Prefer stderr diagnostics; stdout is fallback and may echo the prompt.
  const source = /\S/.test(stderr) ? stderr : stdout
  if (!/\S/.test(source)) {
    return null
  }

  if (source.length <= FAILURE_EXCERPT_SCAN_WINDOW) {
    const lines = collectExcerptLines(source, Number.POSITIVE_INFINITY)
    if (lines.length === 0) {
      return null
    }
    if (lines.length <= FAILURE_EXCERPT_HEAD_LINE_COUNT + 1) {
      return truncateExcerptPart(lines.join(' '), FAILURE_EXCERPT_SINGLE_BUDGET)
    }
    return composeTwoEndExcerpt(
      lines.slice(0, FAILURE_EXCERPT_HEAD_LINE_COUNT),
      lines.at(-1) ?? null
    )
  }

  const headLines = collectExcerptLines(
    source.slice(0, FAILURE_EXCERPT_SCAN_WINDOW),
    FAILURE_EXCERPT_HEAD_LINE_COUNT
  )
  const tailLine =
    collectExcerptLinesFromEnd(source.slice(source.length - FAILURE_EXCERPT_SCAN_WINDOW), 1)[0] ??
    null
  if (headLines.length === 0) {
    return tailLine ? truncateExcerptPart(tailLine, FAILURE_EXCERPT_SINGLE_BUDGET) : null
  }
  return composeTwoEndExcerpt(headLines, tailLine)
}

export function sanitizeAgentFailureDetail(detail: string | null): string | null {
  // Cf covers bidi overrides that could visually reorder persisted, client-synced text.
  const trimmed = detail
    ?.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) {
    return null
  }
  const redacted = trimmed
    .replace(
      /\\\\[^\s"'`<>\\]+\\(?:[^\s"'`<>\\]+(?:\s+[^\s"'`<>\\]+)*(?=\\)\\)*[^\s"'`<>\\]+/g,
      '[path]'
    )
    // JSON may double Windows separators; URL separators must remain single.
    .replace(
      /[A-Za-z]:(?:\\+|\/)(?:[^\s"'`<>\\/|:*?]+(?:\s+[^\s"'`<>\\/|:*?]+)*(?=[\\/])(?:\\+|\/))*[^\s"'`<>\\/|:*?]+/g,
      '[path]'
    )
    // Keep single-segment remedies such as /login while redacting filesystem paths.
    .replace(
      /(^|[\s"'`(=:,])\/(?:[^\s"'`<>/]+(?:\s+[^\s"'`<>/]+)*(?=\/)\/)+[^\s"'`<>/]+/g,
      '$1[path]'
    )
  return redacted.length > 240 ? `${redacted.slice(0, 240).trimEnd()}...` : redacted
}

function composeTwoEndExcerpt(headLines: string[], tailLine: string | null): string {
  const headPart = truncateExcerptPart(headLines.join(' '), FAILURE_EXCERPT_HEAD_BUDGET)
  // Repeated lines (spinner/retry frames) would otherwise show twice.
  if (tailLine === null || headLines.includes(tailLine)) {
    return headPart
  }
  return `${headPart} … ${truncateExcerptPart(tailLine, FAILURE_EXCERPT_TAIL_BUDGET)}`
}

function truncateExcerptPart(value: string, budget: number): string {
  return value.length > budget ? `${value.slice(0, budget).trimEnd()}…` : value
}

function collectExcerptLines(text: string, max: number): string[] {
  // Bare `\r` is a boundary too: progress bars redraw with carriage returns.
  const lines = text.split(/\r\n|\r|\n/)
  const collected: string[] = []
  for (let index = 0; index < lines.length && collected.length < max; index += 1) {
    const line = stripAnsiIfPresent(lines[index]).trim()
    if (line.length > 0) {
      collected.push(line)
    }
  }
  return collected
}

function collectExcerptLinesFromEnd(text: string, max: number): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  const collected: string[] = []
  for (let index = lines.length - 1; index >= 0 && collected.length < max; index -= 1) {
    const line = stripAnsiIfPresent(lines[index]).trim()
    if (line.length > 0) {
      collected.push(line)
    }
  }
  return collected
}
