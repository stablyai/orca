import type { ProjectHostSetup } from './project-types'

export type ReadyProjectHostSetupChoice<T> =
  | { status: 'single'; setup: T }
  | { status: 'none' }
  | { status: 'ambiguous'; candidates: readonly T[] }

export function isReadyProjectHostSetup(setup: Pick<ProjectHostSetup, 'setupState'>): boolean {
  return setup.setupState === 'ready'
}

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
