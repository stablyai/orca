import type { GitOperationProgress } from '../../../../../../shared/git-status-types'

export function areGitOperationProgressEqual(
  a: GitOperationProgress | null,
  b: GitOperationProgress | null
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return (
    a.headName === b.headName &&
    a.onto === b.onto &&
    a.currentStep === b.currentStep &&
    a.totalSteps === b.totalSteps &&
    a.commitSubject === b.commitSubject &&
    a.stoppedBy === b.stoppedBy
  )
}

/**
 * Why: a capped ("too many changes") snapshot never reads the rebase state dir, so
 * treating its absent progress as "no progress" would blank a live step meter
 * between polls. Only a complete snapshot may clear it.
 */
export function resolveNextGitOperationProgress({
  incoming,
  previous,
  statusIsComplete
}: {
  incoming: GitOperationProgress | undefined
  previous: GitOperationProgress | null
  statusIsComplete: boolean
}): GitOperationProgress | null {
  if (!statusIsComplete) {
    return previous
  }
  return incoming ?? null
}
