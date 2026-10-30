type WorktreeCardTitleDisplayInput = {
  storedDisplayName: string | null | undefined
  branchName: string | null | undefined
  linearIssueTitle?: string | null
  jiraIssueTitle?: string | null
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
  // Legacy paths can bypass title selection; normalize nullish persisted titles before trim/rename consumers.
  return typeof value === 'string' ? value : ''
}

export function getWorktreeCardTitleDisplay({
  storedDisplayName,
  branchName,
  linearIssueTitle,
  jiraIssueTitle,
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

  // Prefer confirmed task/review subjects; branch identity remains available in details.
  return (
    normalizeTitle(linearIssueTitle) ??
    normalizeTitle(jiraIssueTitle) ??
    normalizeTitle(issueTitle) ??
    normalizeTitle(reviewTitle) ??
    (normalizedStoredDisplayName ? visibleStoredDisplayName : '')
  )
}
