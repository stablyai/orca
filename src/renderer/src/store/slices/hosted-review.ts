import type { StateCreator } from 'zustand'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { GlobalSettings } from '../../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'

type CacheEntry<T> = { data: T | null; fetchedAt: number }
type FetchOptions = { force?: boolean }

const CACHE_TTL_MS = 60_000

const inflightHostedReviewRequests = new Map<
  string,
  { promise: Promise<HostedReviewInfo | null>; force: boolean; generation: number }
>()
const requestGenerations = new Map<string, number>()

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

export function getHostedReviewCacheKey(
  repoPath: string,
  branch: string,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
): string {
  const target = getActiveRuntimeTarget(settings)
  const scope = target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local'
  return `${scope}::${repoPath}::${branch}`
}

export type HostedReviewSlice = {
  hostedReviewCache: Record<string, CacheEntry<HostedReviewInfo>>
  fetchHostedReviewForBranch: (
    repoPath: string,
    branch: string,
    options?: FetchOptions & {
      linkedGitHubPR?: number | null
      linkedGitLabMR?: number | null
      linkedBitbucketPR?: number | null
    }
  ) => Promise<HostedReviewInfo | null>
}

export const createHostedReviewSlice: StateCreator<AppState, [], [], HostedReviewSlice> = (
  set,
  get
) => ({
  hostedReviewCache: {},

  fetchHostedReviewForBranch: async (
    repoPath,
    branch,
    options
  ): Promise<HostedReviewInfo | null> => {
    const settings = get().settings
    const target = getActiveRuntimeTarget(settings)
    const cacheKey = getHostedReviewCacheKey(repoPath, branch, settings)
    const cached = get().hostedReviewCache[cacheKey]
    const linkedRefetch =
      cached?.data === null &&
      ((options?.linkedGitHubPR ?? null) !== null ||
        (options?.linkedGitLabMR ?? null) !== null ||
        (options?.linkedBitbucketPR ?? null) !== null)
    if (!options?.force && !linkedRefetch && isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightHostedReviewRequests.get(cacheKey)
    if (inflightRequest && (!options?.force || inflightRequest.force) && !linkedRefetch) {
      return inflightRequest.promise
    }

    const generation = (requestGenerations.get(cacheKey) ?? 0) + 1
    requestGenerations.set(cacheKey, generation)

    const request = (async () => {
      try {
        const args = {
          branch,
          linkedGitHubPR: options?.linkedGitHubPR ?? null,
          linkedGitLabMR: options?.linkedGitLabMR ?? null,
          linkedBitbucketPR: options?.linkedBitbucketPR ?? null
        }
        const review =
          target.kind === 'environment'
            ? await callRuntimeRpc<HostedReviewInfo | null>(
                target,
                'hostedReview.forBranch',
                { repo: repoPath, ...args },
                // Why: remote dev boxes can be slower at `git`/`gh` lookups
                // than local desktop repos, especially on Windows filesystem
                // paths. The main-process queue caps concurrency, so a longer
                // timeout no longer risks a background socket stampede.
                { timeoutMs: 30_000 }
              )
            : await window.api.hostedReview.forBranch({ repoPath, ...args })
        if (requestGenerations.get(cacheKey) === generation) {
          set((state) => ({
            hostedReviewCache: {
              ...state.hostedReviewCache,
              [cacheKey]: { data: review, fetchedAt: Date.now() }
            }
          }))
        }
        return review
      } catch (error) {
        console.error('Failed to fetch hosted review:', error)
        if (requestGenerations.get(cacheKey) === generation) {
          set((state) => ({
            hostedReviewCache: {
              ...state.hostedReviewCache,
              [cacheKey]: { data: null, fetchedAt: Date.now() }
            }
          }))
        }
        return null
      } finally {
        const activeRequest = inflightHostedReviewRequests.get(cacheKey)
        if (activeRequest?.generation === generation) {
          inflightHostedReviewRequests.delete(cacheKey)
        }
      }
    })()

    inflightHostedReviewRequests.set(cacheKey, {
      promise: request,
      force: Boolean(options?.force),
      generation
    })
    return request
  }
})
