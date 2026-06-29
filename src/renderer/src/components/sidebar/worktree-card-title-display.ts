type WorktreeCardTitleDisplayInput = {
  storedDisplayName: string | null | undefined
  branchName: string | null | undefined
  linearIssueTitle?: string | null
  issueTitle?: string | null
  reviewTitle?: string | null
}

function normalizeComparableTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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

function isBranchTitle(
  normalizedDisplayName: string | null,
  normalizedBranchName: string | null
): boolean {
  return normalizedDisplayName !== null && normalizedDisplayName === normalizedBranchName
}

export function coerceWorktreeCardVisibleTitle(
  value: string | null | undefined,
  fallback = ''
): string {
  const visibleTitle = typeof value === 'string' ? value : ''
  // Why: legacy card paths still feed trim() and inline rename props, while
  // recovered blank titles should borrow the safe selected identity.
  return visibleTitle.trim() ? visibleTitle : fallback
}

export function getWorktreeCardTitleDisplay({
  storedDisplayName,
  branchName,
  linearIssueTitle,
  issueTitle,
  reviewTitle
}: WorktreeCardTitleDisplayInput): string {
  const normalizedStoredDisplayName = normalizeComparableTitle(storedDisplayName)
  const normalizedBranchName = normalizeComparableTitle(branchName)
  const visibleStoredDisplayName = coerceWorktreeCardVisibleTitle(storedDisplayName)
  const linkedTitle =
    normalizeTitle(linearIssueTitle) ?? normalizeTitle(issueTitle) ?? normalizeTitle(reviewTitle)

  if (!normalizedStoredDisplayName) {
    return linkedTitle ?? normalizedBranchName ?? ''
  }

  if (!normalizedBranchName || !isBranchTitle(normalizedStoredDisplayName, normalizedBranchName)) {
    return visibleStoredDisplayName
  }

  // Why: branch names are available in hover/details; the closed card title
  // should prefer only a confirmed task/review subject, not repo/path guesses.
  return linkedTitle ?? visibleStoredDisplayName
}
