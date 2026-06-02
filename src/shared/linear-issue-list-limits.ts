export const LINEAR_PLAIN_ISSUE_LIST_MAX = 216

export function clampLinearPlainIssueListLimit(limit: number | null | undefined): number {
  return Math.min(Math.max(1, Math.floor(limit ?? 20)), LINEAR_PLAIN_ISSUE_LIST_MAX)
}
