export function checksPanelAsyncResultKey(
  repoId: string,
  branch: string,
  prNumber: number | null
): string {
  return `${repoId}::${branch}::${prNumber ?? 'none'}`
}

export function shouldCommitChecksPanelAsyncResult(
  currentKey: string,
  requestKey: string
): boolean {
  return currentKey === requestKey
}
