/** Pure title classifiers can reuse verdicts across unrelated store writes; changed titles become new keys, so no invalidation signal is needed. */
import { memoizeStringResult } from './string-result-cache'

/** Bound growth across session length while keeping the live pane/title working set cached. */
const MAX_MEMOIZED_TITLES = 1024

export function memoizeTitleClassification<T>(
  classify: (title: string) => T
): (title: string) => T {
  return memoizeStringResult(classify, MAX_MEMOIZED_TITLES)
}
