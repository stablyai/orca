export const WORKTREE_SCAN_FAILURE_KINDS = [
  'xcode-license',
  'developer-tools',
  'architecture-mismatch',
  'unknown'
] as const

export type WorktreeScanFailureKind = (typeof WORKTREE_SCAN_FAILURE_KINDS)[number]

export function isWorktreeScanFailureKind(value: unknown): value is WorktreeScanFailureKind {
  return WORKTREE_SCAN_FAILURE_KINDS.some((kind) => kind === value)
}

export function classifyWorktreeScanFailure(reason: string): WorktreeScanFailureKind {
  if (/Agreeing to the Xcode\/iOS license requires admin privileges/i.test(reason)) {
    return 'xcode-license'
  }
  if (/no developer tools were found/i.test(reason)) {
    return 'developer-tools'
  }
  if (/Unknown system error -86|EBADARCH|Bad CPU type in executable/i.test(reason)) {
    return 'architecture-mismatch'
  }
  return 'unknown'
}
