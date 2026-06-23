const FALLBACK_COMMIT_FAILURE_SUMMARY = 'Commit failed.'
const LINT_COMMIT_FAILURE_SUMMARY = 'Lint failed during commit.'
const PRE_COMMIT_FAILURE_SUMMARY = 'Pre-commit hook failed.'
export const COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS = 64 * 1024

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const LOW_SIGNAL_LINE_PATTERN =
  /^(?:npm\s+(?:warn|warning)\b.*(?:env|config)|npm\s+notice\b|husky\s+-\s+deprecated\b)/i
const HOOK_PATTERN = /\b(?:pre-commit|precommit|husky|lint-staged)\b/i
const LINT_PATTERN = /\b(?:eslint|oxlint|lint-staged|lint)\b/i

function normalizeCommitFailure(raw: string): string {
  return raw
    .slice(0, COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS)
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_PATTERN, '')
    .trim()
}

function getMeaningfulLines(raw: string): string[] {
  const lines = getCommitFailureNormalizedLines(normalizeCommitFailure(raw))
  const hasSignalLine = lines.some((line) => HOOK_PATTERN.test(line) || LINT_PATTERN.test(line))

  if (!hasSignalLine) {
    return lines
  }

  const filtered = lines.filter((line) => !LOW_SIGNAL_LINE_PATTERN.test(line))
  return filtered.length > 0 ? filtered : lines
}

function getCommitFailureNormalizedLines(normalized: string): string[] {
  const lines: string[] = []
  let lineStart = 0
  for (let index = 0; index <= normalized.length; index += 1) {
    if (index < normalized.length && normalized.charCodeAt(index) !== 10) {
      continue
    }
    const line = normalized.slice(lineStart, index).trim()
    if (line.length > 0) {
      lines.push(line)
    }
    lineStart = index + 1
  }
  return lines
}

export function summarizeCommitFailure(raw: string): string {
  const lines = getMeaningfulLines(raw)

  if (lines.length === 0) {
    return FALLBACK_COMMIT_FAILURE_SUMMARY
  }

  if (lines.some((line) => LINT_PATTERN.test(line))) {
    return LINT_COMMIT_FAILURE_SUMMARY
  }

  if (lines.some((line) => HOOK_PATTERN.test(line))) {
    return PRE_COMMIT_FAILURE_SUMMARY
  }

  return lines[0] ?? FALLBACK_COMMIT_FAILURE_SUMMARY
}

export function hasExpandedCommitFailureDetails(raw: string, summary: string): boolean {
  const normalizedRaw = normalizeCommitFailure(raw)
  const normalizedSummary = normalizeCommitFailure(summary)

  if (!normalizedRaw) {
    return false
  }

  if (raw.length > COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS) {
    return true
  }

  return (
    foldCommitFailureComparisonWhitespace(normalizedRaw) !==
    foldCommitFailureComparisonWhitespace(normalizedSummary)
  )
}

// Why: hook output can include paste-sized multiline text; compare normalized
// details without another regex pass over the bounded renderer scan window.
function foldCommitFailureComparisonWhitespace(value: string): string {
  let result = ''
  let pendingSpace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isCommitFailureComparisonWhitespace(code)) {
      pendingSpace = result.length > 0
      continue
    }
    if (pendingSpace) {
      result += ' '
      pendingSpace = false
    }
    result += value[index]
  }
  return result
}

function isCommitFailureComparisonWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
