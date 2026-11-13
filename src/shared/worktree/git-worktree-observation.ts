export type GitWorktreeObservation = {
  isBare: boolean
  isMainWorktree: boolean
  branch: string
  prunable: boolean
}

export function readGitWorktreeObservation(value: unknown): GitWorktreeObservation | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('isBare' in value) ||
    typeof value.isBare !== 'boolean' ||
    !('isMainWorktree' in value) ||
    typeof value.isMainWorktree !== 'boolean' ||
    !('branch' in value) ||
    typeof value.branch !== 'string' ||
    !('prunable' in value) ||
    typeof value.prunable !== 'boolean'
  ) {
    return undefined
  }
  return {
    isBare: value.isBare,
    isMainWorktree: value.isMainWorktree,
    branch: value.branch,
    prunable: value.prunable
  }
}

export function equalGitWorktreeObservations(
  left: GitWorktreeObservation | undefined,
  right: GitWorktreeObservation
): boolean {
  return (
    !!left &&
    left.isBare === right.isBare &&
    left.isMainWorktree === right.isMainWorktree &&
    left.branch === right.branch &&
    left.prunable === right.prunable
  )
}
