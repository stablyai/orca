// Why: label/title wording for the dropdown rows, kept apart from the priority ladder so copy edits
// do not touch the state machine.

export function describePushCount(ahead: number): string {
  return `Push ${ahead} commit${ahead === 1 ? '' : 's'}`
}

export function describePullCount(behind: number): string {
  return `Pull ${behind} commit${behind === 1 ? '' : 's'}`
}

export function describeFastForwardCount(behind: number): string {
  return `Fast-forward ${behind} commit${behind === 1 ? '' : 's'}`
}

export function describeSyncCounts(ahead: number, behind: number): string {
  return `Pull ${behind}, push ${ahead}`
}

export function formatCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}

export function formatSyncLabel(base: string, ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) {
    return base
  }
  return `${base} (↓${behind} ↑${ahead})`
}

export function formatForcePushTitle(
  branchCommitsAhead: number | undefined,
  upstreamName?: string
): string {
  const countText =
    branchCommitsAhead && branchCommitsAhead > 0
      ? `${branchCommitsAhead} branch commit${branchCommitsAhead === 1 ? '' : 's'}`
      : 'this branch'
  return `Remote only has older copies of local commits. Force push ${countText} with lease to update ${upstreamName ?? 'the remote branch'}.`
}

export function formatManualForcePushTitle(
  ahead: number,
  behind: number,
  upstreamName?: string
): string {
  const commitText = ahead === 1 ? '1 local commit' : `${ahead} local commits`
  if (behind > 0) {
    return `Force push ${commitText} with lease to update ${upstreamName ?? 'the remote branch'} and replace remote-only commits.`
  }
  return `Force push ${commitText} with lease to update ${upstreamName ?? 'the remote branch'}.`
}

export function formatUnpublishedForcePushTitle(branchCommitsAhead: number | undefined): string {
  const countText =
    branchCommitsAhead && branchCommitsAhead > 0
      ? `${branchCommitsAhead} branch commit${branchCommitsAhead === 1 ? '' : 's'}`
      : 'this branch'
  return `Force push ${countText} with lease and set an upstream if needed.`
}

export function formatRebaseBaseRef(baseRef: string): string {
  return baseRef.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
}
