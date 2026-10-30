import type { YouTrackIssue } from '../youtrack-types'
import type { SmartWorkspaceSourceRow } from './smart-workspace-source-results'

/** A full issue ID or issue URL names one issue; anything shorter is an ID-prefix suggestion. */
export function isExactYouTrackMatch(issue: YouTrackIssue, input: string): boolean {
  const trimmed = input.trim()
  return issue.idReadable === trimmed.toUpperCase() || /^https?:\/\//i.test(trimmed)
}

/** Splits YouTrack rows into exact matches (full ID or issue URL) and ID-prefix suggestions. */
export function partitionYouTrackRows(
  issues: YouTrackIssue[],
  input: string
): [SmartWorkspaceSourceRow[], SmartWorkspaceSourceRow[]] {
  const exact: SmartWorkspaceSourceRow[] = []
  const prefix: SmartWorkspaceSourceRow[] = []
  for (const issue of issues) {
    const row: SmartWorkspaceSourceRow = {
      kind: 'youtrack',
      value: `youtrack-${issue.idReadable}`,
      issue
    }
    if (isExactYouTrackMatch(issue, input)) {
      exact.push(row)
    } else {
      prefix.push(row)
    }
  }
  return [exact, prefix]
}
