import type { AppState } from '@/store/types'
import { buildParentPrChecksProjection } from './parent-pr-checks-rows'
import type {
  BuildParentPrChecksRowsArgs,
  ParentPrChecksProjection
} from './parent-pr-checks-row-types'

type ReviewCacheState = Pick<AppState, 'checksCache' | 'hostedReviewCache' | 'prCache'>
type ReviewCacheName = keyof ReviewCacheState
type ProjectionInputs = Omit<
  BuildParentPrChecksRowsArgs,
  'checksCache' | 'hostedReviewCache' | 'prCache'
>
type ProjectionBuilder = (args: BuildParentPrChecksRowsArgs) => ParentPrChecksProjection
type CacheDependency = {
  cacheName: ReviewCacheName
  key: string
  value: unknown
}

function trackCacheReads<K extends ReviewCacheName>(
  state: ReviewCacheState,
  cacheName: K,
  dependencies: CacheDependency[]
): ReviewCacheState[K] {
  return new Proxy(state[cacheName], {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver)
      if (typeof property === 'string') {
        dependencies.push({ cacheName, key: property, value })
      }
      return value
    }
  })
}

function dependenciesAreCurrent(
  state: ReviewCacheState,
  dependencies: readonly CacheDependency[]
): boolean {
  return dependencies.every(
    ({ cacheName, key, value }) => Reflect.get(state[cacheName], key) === value
  )
}

export function createParentPrChecksProjectionSelector(
  inputs: ProjectionInputs,
  buildProjection: ProjectionBuilder = buildParentPrChecksProjection
): (state: ReviewCacheState) => ParentPrChecksProjection {
  let cached: { dependencies: CacheDependency[]; projection: ParentPrChecksProjection } | null =
    null

  return (state) => {
    if (cached && dependenciesAreCurrent(state, cached.dependencies)) {
      return cached.projection
    }

    const dependencies: CacheDependency[] = []
    // Why: global provider refreshes replace these maps frequently; track only
    // cache keys the attached-worktree projection actually reads.
    const projection = buildProjection({
      ...inputs,
      hostedReviewCache: trackCacheReads(state, 'hostedReviewCache', dependencies),
      prCache: trackCacheReads(state, 'prCache', dependencies),
      checksCache: trackCacheReads(state, 'checksCache', dependencies)
    })
    cached = { dependencies, projection }
    return projection
  }
}
