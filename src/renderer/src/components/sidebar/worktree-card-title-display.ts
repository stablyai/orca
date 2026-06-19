type WorktreeCardTitleDisplayInput = {
  storedDisplayName: string
  branchName: string
  linearIssueTitle?: string | null
  issueTitle?: string | null
  reviewTitle?: string | null
}

function normalizeTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  if (/^(Loading .+|.+ details unavailable)$/i.test(trimmed)) {
    return null
  }
  return trimmed
}

function isBranchTitle(displayName: string, branchName: string): boolean {
  return displayName.trim() === branchName.trim()
}

export function getWorktreeCardTitleDisplay({
  storedDisplayName,
  branchName,
  linearIssueTitle,
  issueTitle,
  reviewTitle
}: WorktreeCardTitleDisplayInput): string {
  if (!branchName || !isBranchTitle(storedDisplayName, branchName)) {
    return storedDisplayName
  }

  // Why: branch names are available in hover/details; the closed card title
  // should prefer only a confirmed task/review subject, not repo/path guesses.
  return (
    normalizeTitle(linearIssueTitle) ??
    normalizeTitle(issueTitle) ??
    normalizeTitle(reviewTitle) ??
    storedDisplayName
  )
}
