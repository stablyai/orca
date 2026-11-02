import { githubTaskBinding } from '@/lib/github-task-observation'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { getWorkItemCountedTotalPages } from '../../../../shared/work-items'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { isGitHubWorkItemsQueryTooLarge } from '../slices/github-work-items-query-bounds'
import { workItemsCacheKey, workItemsInflightRequestKey } from './cache-identity'
import {
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightWorkItemsRequests,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from './request-coordination'
import { findRepoForGitHubOwner } from './repository-routing'
import {
  countGitHubWorkItemsForRepo,
  getGitHubWorkItemRequestContext,
  getGitHubWorkItemSourceCacheScope,
  getGitHubSourceTarget
} from './work-item-routing'

export const createWorkItemCountActions = (
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'countWorkItemsAcrossRepos'> => ({
  countWorkItemsAcrossRepos: async (repos, query, perRepoLimit, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { totalCount: 0, totalPages: 0 }
    }
    const owner = get().githubSourceCollections
    const attempts = repos.map((r) =>
      owner.capture(findRepoForGitHubOwner(get(), r.repoId, r.path), r.sourceContext)
    )
    const key = owner.countKey(
      attempts.map((attempt) => attempt.scope),
      query,
      perRepoLimit
    )
    const counts = await Promise.all(
      repos.map(async (r, index) => {
        const requestState = get(),
          attempt = attempts[index]
        const requestContext = getGitHubWorkItemRequestContext(
          requestState,
          getGitHubSourceTarget(requestState, attempt.repo, r.sourceContext),
          r.repoId,
          r.path,
          r.sourceContext
        )
        const cacheKey = workItemsCacheKey(
          r.repoId,
          perRepoLimit,
          query,
          r.sourceContext
            ? getTaskSourceCacheScope(r.sourceContext)
            : attempt.repo
              ? getGitHubWorkItemSourceCacheScope(attempt.repo)
              : undefined,
          attempt.repo && githubTaskBinding(attempt.repo)
        )
        const inflightKey = `${workItemsInflightRequestKey(cacheKey, requestContext.target)}::${attempt.binding ? requestState.githubTaskCache.bindingIdentity(attempt.binding) : ''}`
        const discovery = inflightWorkItemsRequests.get(inflightKey)?.promise
        let count: number
        await acquireWorkItemSlot()
        try {
          if (!owner.current(attempt)) {
            return undefined
          }
          count = await countGitHubWorkItemsForRepo(requestContext, {
            query: query || undefined,
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          })
        } catch {
          return undefined
        } finally {
          releaseWorkItemSlot()
        }
        await discovery?.catch(() => undefined)
        const evidence = owner.verified(attempt, query)
        if (
          !owner.current(attempt) ||
          (attempt.binding && !evidence) ||
          get().workItemsInvalidationNonce !== attempt.nonce
        ) {
          return undefined
        }
        if (evidence?.empty && count !== 0) {
          return undefined
        }
        if (Number.isFinite(count) && (count > 0 || !attempt.binding)) {
          return count
        }
        return evidence?.empty ? 0 : undefined
      })
    )
    if (
      counts.some((count) => count === undefined) ||
      attempts.some((attempt) => !owner.current(attempt))
    ) {
      return undefined
    }
    const valid = counts.flatMap((count) => (count === undefined ? [] : [count]))
    const answer = {
      totalCount: valid.reduce((sum, count) => sum + count, 0),
      totalPages: getWorkItemCountedTotalPages(valid, perRepoLimit)
    }
    return attempts.every((attempt) => attempt.binding)
      ? owner.answer(key, attempts, answer, query, perRepoLimit)
      : answer
  }
})
