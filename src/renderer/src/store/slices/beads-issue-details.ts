import type { AppState } from '../types'
import type { BeadsIssueDetails } from '../../../../shared/beads-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { beadsAddComment, beadsGetIssueDetails } from '@/runtime/runtime-beads-client'
import {
  BEADS_CACHE_TTL,
  beadsIssueDetailsCacheKey,
  currentBeadsReadGeneration,
  evictOldestBeadsEntries,
  MAX_BEADS_DETAILS_CACHE_ENTRIES,
  requireBeadsRepoId
} from './beads-issue-cache'

export type BeadsIssueDetailsActions = {
  /** Relations + comments for one issue; null = unavailable/unknown. Typed unsupported errors rethrow so the dialog can degrade. */
  fetchBeadsIssueDetails: (
    sourceContext: TaskSourceContext,
    id: string,
    options?: { force?: boolean }
  ) => Promise<BeadsIssueDetails | null>
  /** No optimistic insert: posts, then swaps in the re-fetched details. Errors rethrow for the UI toast. */
  addBeadsIssueComment: (
    sourceContext: TaskSourceContext,
    id: string,
    text: string
  ) => Promise<BeadsIssueDetails>
}

type InflightBeadsDetailsRequest = {
  promise: Promise<BeadsIssueDetails | null>
  generation: number
}

const inflightDetailsRequests = new Map<string, InflightBeadsDetailsRequest>()

/** Called alongside the generation bump so stranded detail reads cannot repopulate a cleared cache. */
export function clearInflightBeadsDetailsReads(): void {
  inflightDetailsRequests.clear()
}

type SliceSet = (updater: (s: AppState) => Partial<AppState>) => void

export function createBeadsIssueDetailsActions(
  set: SliceSet,
  get: () => AppState
): BeadsIssueDetailsActions {
  return {
    fetchBeadsIssueDetails: async (sourceContext, id, options) => {
      const repoId = requireBeadsRepoId(sourceContext)
      const cacheKey = beadsIssueDetailsCacheKey(sourceContext, id)
      const cached = get().beadsIssueDetailsCache[cacheKey]
      if (
        !options?.force &&
        cached &&
        cached.generation === currentBeadsReadGeneration() &&
        Date.now() - cached.fetchedAt < BEADS_CACHE_TTL
      ) {
        return cached.details
      }
      const inflight = inflightDetailsRequests.get(cacheKey)
      if (!options?.force && inflight && inflight.generation === currentBeadsReadGeneration()) {
        return inflight.promise
      }
      const generation = currentBeadsReadGeneration()
      let requestEntry: InflightBeadsDetailsRequest
      const promise = beadsGetIssueDetails(sourceContext, { repoId, id })
        .then((result) => {
          if (
            inflightDetailsRequests.get(cacheKey) === requestEntry &&
            generation === currentBeadsReadGeneration()
          ) {
            set((s) => ({
              beadsIssueDetailsCache: evictOldestBeadsEntries(
                {
                  ...s.beadsIssueDetailsCache,
                  [cacheKey]: { details: result.details, fetchedAt: Date.now(), generation }
                },
                MAX_BEADS_DETAILS_CACHE_ENTRIES
              )
            }))
          }
          return result.details
        })
        .finally(() => {
          if (inflightDetailsRequests.get(cacheKey) === requestEntry) {
            inflightDetailsRequests.delete(cacheKey)
          }
        })
      requestEntry = { promise, generation }
      inflightDetailsRequests.set(cacheKey, requestEntry)
      return promise
    },

    addBeadsIssueComment: async (sourceContext, id, text) => {
      const repoId = requireBeadsRepoId(sourceContext)
      const result = await beadsAddComment(sourceContext, { repoId, id, text })
      const details = result.details
      if (!details) {
        throw new Error('Beads comment failed: bd is unavailable or not initialized here.')
      }
      const prefix = `${getTaskSourceCacheScope(sourceContext)}::`
      const detailsKey = beadsIssueDetailsCacheKey(sourceContext, id)
      set((s) => {
        const beadsListCache = { ...s.beadsListCache }
        // Comment counts changed: reconcile cached lists and mark them stale for SWR refetch.
        for (const [key, entry] of Object.entries(beadsListCache)) {
          if (
            key.startsWith(prefix) &&
            entry.data?.issues.some((issue) => issue.id === details.issue.id)
          ) {
            beadsListCache[key] = {
              ...entry,
              fetchedAt: 0,
              data: entry.data && {
                ...entry.data,
                issues: entry.data.issues.map((issue) =>
                  issue.id === details.issue.id ? details.issue : issue
                )
              }
            }
          }
        }
        return {
          beadsListCache,
          beadsIssueDetailsCache: evictOldestBeadsEntries(
            {
              ...s.beadsIssueDetailsCache,
              [detailsKey]: {
                details,
                fetchedAt: Date.now(),
                generation: currentBeadsReadGeneration()
              }
            },
            MAX_BEADS_DETAILS_CACHE_ENTRIES
          )
        }
      })
      return details
    }
  }
}
