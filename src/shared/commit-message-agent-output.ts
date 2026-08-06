/** Strips noise around the agent's output: surrounding whitespace, a single
 *  enclosing fenced code block, and lone "Generating…" preamble lines some
 *  CLIs print before the real answer. */
export function cleanGeneratedCommitMessage(raw: string): string {
  // Why: agent output can include very large generated bodies; normalize and
  // unwrap by scanning boundaries instead of building newline-sized arrays.
  let text = normalizeGeneratedCommitMessageLineFeeds(raw).trim()

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

  const fenced = findEnclosingCommitMessageFenceBody(text)
  if (fenced !== null) {
    text = fenced.trim()
  }

  // Why: some CLIs format a one-shot answer as a list item even when the
  // prompt asks for raw text; a Git subject should not carry that marker.
  text = text.replace(/^(\s*)(?:[-*•●]\s+|\d+[.)]\s+)/, '$1').trim()

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
  // CSI (colors/cursor) and OSC (titles/hyperlinks) both appear in raw CLI
  // failure output once it is shown verbatim instead of parsed.
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

// Only the two ends of the output are read, like glancing at the first and
// last lines of a long log.
const FAILURE_EXCERPT_SCAN_WINDOW = 8192
const FAILURE_EXCERPT_HEAD_LINE_COUNT = 2
// Why: when both ends are shown, the tail gets the larger budget because most
// CLIs print the operative error last; the head budget covers CLIs that
// front-load it. A lone excerpt keeps the whole toast/persistence budget.
const FAILURE_EXCERPT_HEAD_BUDGET = 100
const FAILURE_EXCERPT_TAIL_BUDGET = 130
const FAILURE_EXCERPT_SINGLE_BUDGET = 240

// Why: agent CLIs share no error format, and per-CLI parsing rots every time a
// vendor rewords a message. Orca deliberately does NOT interpret failure
// output — it excerpts it positionally (first lines plus last line) so every
// CLI's real failure text reaches the user. Callers must still sanitize the
// excerpt before display or persistence.
export function excerptAgentFailureOutput(stdout: string, stderr: string): string | null {
  // stderr is where CLIs put diagnostics; stdout is the fallback for the ones
  // that report failures inline (and often echoes the prompt, so it never
  // overrides a non-blank stderr).
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
