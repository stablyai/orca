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

export function coerceWorktreeCardVisibleTitle(value: string | null | undefined): string {
  // Why: the legacy card path can bypass title selection but still feeds trim()
  // and inline rename props, so nullish persisted titles stop at this boundary.
  return typeof value === 'string' ? value : ''
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

  if (!normalizedBranchName) {
    return normalizedStoredDisplayName ? visibleStoredDisplayName : ''
  }

  if (
    normalizedStoredDisplayName &&
    !isBranchTitle(normalizedStoredDisplayName, normalizedBranchName)
  ) {
    return visibleStoredDisplayName
  }

  // Why: branch names are available in hover/details; the closed card title
  // should prefer only a confirmed task/review subject, not repo/path guesses.
  return (
    normalizeTitle(linearIssueTitle) ??
    normalizeTitle(issueTitle) ??
    normalizeTitle(reviewTitle) ??
    (normalizedStoredDisplayName ? visibleStoredDisplayName : '')
  )
}
