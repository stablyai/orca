export function splitRemoteBranchName(refName: string): {
  remoteName: string
  branchName: string
} | null {
  const slashIndex = refName.indexOf('/')
  if (slashIndex <= 0 || slashIndex === refName.length - 1) {
    return null
  }
  return {
    remoteName: refName.slice(0, slashIndex),
    branchName: refName.slice(slashIndex + 1)
  }
}

export function gitRefTargetsBranchName(
  refName: string | null | undefined,
  branchName: string
): boolean {
  const trimmed = refName?.trim()
  if (!trimmed || !branchName) {
    return false
  }
  const headsPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsPrefix)) {
    return trimmed.slice(headsPrefix.length) === branchName
  }
  const remotesPrefix = 'refs/remotes/'
  if (trimmed.startsWith(remotesPrefix)) {
    return splitRemoteBranchName(trimmed.slice(remotesPrefix.length))?.branchName === branchName
  }
  return trimmed === branchName || splitRemoteBranchName(trimmed)?.branchName === branchName
}

export function gitRefTargetsBranchOnRemote(
  refName: string | null | undefined,
  remoteName: string,
  branchName: string
): boolean {
  const trimmed = refName?.trim()
  if (!trimmed || !remoteName || !branchName) {
    return false
  }
  // Why: fork reviews can target fork/main while the saved base is origin/main.
  // Remote-qualified refs must match both pieces, not only the branch leaf.
  if (
    trimmed === `${remoteName}/${branchName}` ||
    trimmed === `remotes/${remoteName}/${branchName}` ||
    trimmed === `refs/remotes/${remoteName}/${branchName}`
  ) {
    return true
  }
  if (trimmed.startsWith('refs/remotes/') || trimmed.startsWith('remotes/')) {
    return false
  }
  const headsPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsPrefix)) {
    return trimmed.slice(headsPrefix.length) === branchName
  }
  return trimmed === branchName
}
