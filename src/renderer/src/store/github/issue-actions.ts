import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { issueCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { isFresh, withBoundedCacheEntry } from './cache-policy'
import { debouncedSaveCache } from './cache-persistence'
import { inflightIssueRequests } from './request-coordination'
import { findRepoForGitHubOwner } from './repository-routing'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'

export const createIssueActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchIssue'> => ({
  fetchIssue: async (repoPath, number, options) => {
    const repo = findRepoForGitHubOwner(get(), options?.repoId, repoPath)
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(
      get().settings,
      repo,
      options?.sourceContext
    )
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      issueCacheSuffix(number, options?.ownerRepo),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )
    const cached = get().issueCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightIssueRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const requestContext = getGitHubWorkItemRequestContext(
          get(),
          requestSettings,
          repoId ?? repoPath,
          repoPath,
          options?.sourceContext
        )
        const issue =
          requestContext.target.kind === 'environment'
            ? await callRuntimeRpc<IssueInfo | null>(
                { kind: 'environment', environmentId: requestContext.target.environmentId },
                'github.issue',
                {
                  repo: requestContext.target.runtimeRepoId,
                  number,
                  ...(options?.ownerRepo ? { ownerRepo: options.ownerRepo } : {})
                },
                { timeoutMs: 30_000 }
              )
            : await window.api.gh.issue({
                repoPath,
                repoId,
                number,
                sourceContext: options?.sourceContext,
                ...(options?.ownerRepo ? { ownerRepo: options.ownerRepo } : {})
              })
        if (issue && options?.ownerRepo) {
          const link = parseGitHubIssueOrPRLink(issue.url)
          if (
            link?.type !== 'issue' ||
            link.number !== number ||
            githubRepoIdentityKey(link.slug) !== githubRepoIdentityKey(options.ownerRepo)
          ) {
            throw new Error('Issue lookup returned a different repository')
          }
        }
        set((s) => ({
          issueCache: withBoundedCacheEntry(s.issueCache, cacheKey, {
            data: issue,
            fetchedAt: Date.now()
          })
        }))
        debouncedSaveCache(get())
        return issue
      } catch (err) {
        console.error('Failed to fetch issue:', err)
        set((s) => ({
          issueCache: withBoundedCacheEntry(s.issueCache, cacheKey, {
            data: null,
            fetchedAt: Date.now()
          })
        }))
        debouncedSaveCache(get())
        return null
      } finally {
        inflightIssueRequests.delete(cacheKey)
      }
    })()

    inflightIssueRequests.set(cacheKey, request)
    return request
  }
})
