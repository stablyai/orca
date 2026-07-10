export function describePushCount(ahead: number): string {
  return `Push ${ahead} commit${ahead === 1 ? '' : 's'}`
}

export function describePullCount(behind: number): string {
  return `Pull ${behind} commit${behind === 1 ? '' : 's'}`
}

export function describeSyncCounts(ahead: number, behind: number): string {
  return `Pull ${behind}, push ${ahead}`
}

export function describeForcePushWithLease(
  count: number | undefined,
  upstreamName?: string
): string {
  const countText =
    count && count > 0 ? `${count} branch commit${count === 1 ? '' : 's'}` : 'this branch'
  return `Remote only has older copies of local commits. Force push ${countText} with lease to update ${upstreamName ?? 'the remote branch'}.`
}
