// Every status path must request the same comparison revision to keep the chip between polls.
// Only the visible worktree's SourceControl is mounted and its effect cleanup
// deletes on every change, so this holds ~1 entry and needs no eviction.
const branchLineTotalComparisonBaseByWorktree = new Map<string, string>()

/** No comparison revision means no line-total computation on the host. */
export function setBranchLineTotalComparisonBase(
  worktreeId: string,
  comparisonBaseOid: string | null
): void {
  if (!comparisonBaseOid) {
    branchLineTotalComparisonBaseByWorktree.delete(worktreeId)
    return
  }
  branchLineTotalComparisonBaseByWorktree.set(worktreeId, comparisonBaseOid)
}

export function getBranchLineTotalComparisonBase(worktreeId: string): string | undefined {
  return branchLineTotalComparisonBaseByWorktree.get(worktreeId)
}

export function clearBranchLineTotalRequestGateForTests(): void {
  branchLineTotalComparisonBaseByWorktree.clear()
}
