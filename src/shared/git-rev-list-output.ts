import { getProcessOutputFields } from './process-output-field-scanner'

export type GitRevListAheadBehindCounts = {
  ahead: number
  behind: number
}

export type GitRevListAheadBehindParseResult =
  | ({ status: 'ok' } & GitRevListAheadBehindCounts)
  | { status: 'unexpected-field-count' }
  | { status: 'unparseable-counts' }

export function parseGitRevListAheadBehindCounts(output: string): GitRevListAheadBehindParseResult {
  // Why: these Git outputs sit on status/paste-adjacent hot paths; scan only needed fields.
  const fields = getProcessOutputFields(output, 3)
  if (fields.length !== 2) {
    return { status: 'unexpected-field-count' }
  }

  const ahead = parseGitRevListNonNegativeCount(fields[0])
  const behind = parseGitRevListNonNegativeCount(fields[1])
  if (ahead === null || behind === null) {
    return { status: 'unparseable-counts' }
  }

  return { status: 'ok', ahead, behind }
}

export function parseGitRevListFirstParentOid(output: string): string | null {
  return getProcessOutputFields(output, 2)[1] ?? null
}

function parseGitRevListNonNegativeCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}
