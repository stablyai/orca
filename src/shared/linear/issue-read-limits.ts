export const LINEAR_ISSUE_LIST_MAX = 216
export const LINEAR_ISSUE_API_PAGE_SIZE_MAX = 50

export function clampLinearIssueListLimit(limit: number | null | undefined): number {
  return Math.min(Math.max(1, Math.floor(limit ?? 20)), LINEAR_ISSUE_LIST_MAX)
}
