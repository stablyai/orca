import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

export type ReviewSnapshot = {
  structure: readonly unknown[]
  pr: AppState['prCache']
  hosted: AppState['hostedReviewCache']
}
let current: ReviewSnapshot | undefined

export function reviewSnapshot(state: AppState): ReviewSnapshot {
  const structure = [selectWorktreesByRepo(state), state.repos, state.settings]
  if (
    !current ||
    !structure.every((value, index) => value === current!.structure[index]) ||
    current.pr !== state.prCache ||
    current.hosted !== state.hostedReviewCache
  ) {
    current = { structure, pr: state.prCache, hosted: state.hostedReviewCache }
  }
  return current
}

const changes = new WeakMap<
  ReviewSnapshot,
  WeakMap<ReviewSnapshot, { pr: Set<string>; hosted: Set<string> }>
>()

function changedKeys<T>(
  before: Record<string, T> = {},
  after: Record<string, T> = {}
): Set<string> {
  const result = new Set<string>()
  for (const key in before) {
    if (before[key] !== after[key]) {
      result.add(key)
    }
  }
  for (const key in after) {
    if (before[key] !== after[key]) {
      result.add(key)
    }
  }
  return result
}

/** Diff the shared caches once per snapshot pair, across every section and mounted card. */
export function changedReviewKeys(before: ReviewSnapshot, after: ReviewSnapshot) {
  let next = changes.get(before)
  const cached = next?.get(after)
  if (cached) {
    return cached
  }
  const result = {
    pr: before.pr === after.pr ? new Set<string>() : changedKeys(before.pr, after.pr),
    hosted:
      before.hosted === after.hosted ? new Set<string>() : changedKeys(before.hosted, after.hosted)
  }
  if (!next) {
    next = new WeakMap()
    changes.set(before, next)
  }
  next.set(after, result)
  return result
}
