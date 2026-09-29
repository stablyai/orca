import type { ProjectHostSetup } from './project-types'

export type ReadyProjectHostSetupChoice<T> =
  | { status: 'single'; setup: T }
  | { status: 'none' }
  | { status: 'ambiguous'; candidates: readonly T[] }

export function isReadyProjectHostSetup(setup: Pick<ProjectHostSetup, 'setupState'>): boolean {
  return setup.setupState === 'ready'
}

/**
 * Why (STA-6080): the surviving candidates are in persistence order, which is neither a user choice
 * nor a ranking. Taking the first aimed worktree creation at an unrelated checkout of the same
 * project, so more than one survivor is reported as ambiguous and left for the caller to surface —
 * the CLI refuses with the candidates named, the composer asks which one to run on.
 */
export function chooseReadyProjectHostSetup<T>(
  candidates: readonly T[]
): ReadyProjectHostSetupChoice<T> {
  if (candidates.length === 0) {
    return { status: 'none' }
  }
  if (candidates.length === 1) {
    return { status: 'single', setup: candidates[0] }
  }
  return { status: 'ambiguous', candidates }
}
