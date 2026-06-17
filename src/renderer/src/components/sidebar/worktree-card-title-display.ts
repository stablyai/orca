type WorktreeCardTitleDisplayInput = {
  storedDisplayName: string
  branchName: string
  path: string
  repositoryName?: string | null
  linearIssueTitle?: string | null
  issueTitle?: string | null
  reviewTitle?: string | null
}

function getDirectoryName(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || normalized || folderPath
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

function isBranchNamePiece(value: string, branchName: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  const branchTail = branchName.split('/').at(-1) ?? branchName
  return trimmed === branchName.trim() || trimmed === branchTail.trim()
}

export function getWorktreeCardTitleDisplay({
  storedDisplayName,
  branchName,
  path,
  repositoryName,
  linearIssueTitle,
  issueTitle,
  reviewTitle
}: WorktreeCardTitleDisplayInput): string {
  if (!branchName || !isBranchTitle(storedDisplayName, branchName)) {
    return storedDisplayName
  }

  // Why: branch names are available in hover/details; the closed card title
  // should prefer the attached task or review's human-readable subject.
  const directoryName = getDirectoryName(path)
  const nonBranchDirectoryName = isBranchNamePiece(directoryName, branchName) ? null : directoryName
  return (
    normalizeTitle(linearIssueTitle) ??
    normalizeTitle(issueTitle) ??
    normalizeTitle(reviewTitle) ??
    normalizeTitle(nonBranchDirectoryName) ??
    normalizeTitle(repositoryName) ??
    'Workspace'
  )
}
