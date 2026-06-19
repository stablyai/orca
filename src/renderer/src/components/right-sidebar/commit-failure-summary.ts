const FALLBACK_COMMIT_FAILURE_SUMMARY = 'Commit failed.'
const LINT_COMMIT_FAILURE_SUMMARY = 'Lint failed during commit.'
const PRE_COMMIT_FAILURE_SUMMARY = 'Pre-commit hook failed.'

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
  return raw.replace(ANSI_PATTERN, '').replace(/\r\n?/g, '\n').replace(CONTROL_PATTERN, '').trim()
}

function getMeaningfulLines(raw: string): string[] {
  const lines = normalizeCommitFailure(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const hasSignalLine = lines.some((line) => HOOK_PATTERN.test(line) || LINT_PATTERN.test(line))

  if (!hasSignalLine) {
    return lines
  }

  const filtered = lines.filter((line) => !LOW_SIGNAL_LINE_PATTERN.test(line))
  return filtered.length > 0 ? filtered : lines
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

  return normalizedRaw.replace(/\s+/g, ' ') !== normalizedSummary.replace(/\s+/g, ' ')
}
