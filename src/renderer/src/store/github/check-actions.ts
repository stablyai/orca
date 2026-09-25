import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import { syncPRChecksStatus } from '../slices/github-checks'
import {
  getPRChecksCacheTtl,
  prChecksCacheSuffix,
  sourceScopedRepoCacheKey
} from './cache-identity'
import { isFresh, withBoundedCacheEntry } from './cache-policy'
import { debouncedSaveCache } from './cache-persistence'
import { inflightChecksRequests } from './request-coordination'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'

export const createCheckActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchPRChecks' | 'fetchPRCheckDetails'> => ({
  fetchPRChecks: async (
    repoPath,
    prNumber,
    branch,
    headSha,
    prRepo,
    options
  ): Promise<PRCheckDetail[]> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(
      get().settings,
      repo,
      options?.sourceContext
    )
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      prChecksCacheSuffix(prNumber, prRepo, headSha),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )
    const legacyCacheKey = headSha
      ? sourceScopedRepoCacheKey(
          repoPath,
          repoId,
          prChecksCacheSuffix(prNumber, prRepo),
          requestSettings,
          repo?.connectionId,
          repo?.executionHostId,
          options?.sourceContext,
          repo !== undefined
        )
      : cacheKey
    const inflightKey = cacheKey
    const cached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
    if (
      !options?.force &&
      !options?.noCache &&
      isFresh(cached, getPRChecksCacheTtl(cached)) &&
      (!headSha || cached.headSha === headSha)
    ) {
      const cachedChecks = cached.data ?? []
      const prStatusUpdate = syncPRChecksStatus(
        get(),
        repoPath,
        repoId,
        branch,
        cachedChecks,
        cached.headSha,
        prRepo,
        requestSettings,
        repo?.connectionId,
        repo?.executionHostId,
        repo !== undefined
      )
      if (prStatusUpdate) {
        set(prStatusUpdate)
        debouncedSaveCache(get())
      }
      return cachedChecks
    }

    const inflightRequest = inflightChecksRequests.get(inflightKey)
    if (inflightRequest) {
      if (
        (options?.force && !inflightRequest.force) ||
        (options?.noCache && !inflightRequest.noCache)
      ) {
        await inflightRequest.promise.catch(() => {})
      } else {
        return inflightRequest.promise
      }
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
        const checks =
          requestContext.target.kind === 'environment'
            ? await callRuntimeRpc<PRCheckDetail[]>(
                { kind: 'environment', environmentId: requestContext.target.environmentId },
                'github.prChecks',
                {
                  repo: requestContext.target.runtimeRepoId,
                  prNumber,
                  headSha,
                  prRepo: prRepo ?? null,
                  noCache: Boolean(options?.force || options?.noCache)
                },
                { timeoutMs: 30_000 }
              )
            : ((await window.api.gh.prChecks({
                repoPath,
                repoId,
                prNumber,
                headSha,
                prRepo: prRepo ?? null,
                noCache: Boolean(options?.force || options?.noCache),
                sourceContext: options?.sourceContext
              })) as PRCheckDetail[])
        set((s) => {
          const nextState: Partial<AppState> = {
            checksCache: withBoundedCacheEntry(s.checksCache, cacheKey, {
              data: checks,
              fetchedAt: Date.now(),
              headSha
            })
          }

          const prStatusUpdate = syncPRChecksStatus(
            s,
            repoPath,
            repoId,
            branch,
            checks,
            headSha,
            prRepo,
            requestSettings,
            repo?.connectionId,
            repo?.executionHostId,
            repo !== undefined
          )
          if (prStatusUpdate?.prCache) {
            nextState.prCache = prStatusUpdate.prCache
          }

          return nextState
        })
        debouncedSaveCache(get())
        return checks
      } catch (err) {
        console.error('Failed to fetch PR checks:', err)
        const latestCached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
        if (latestCached?.data && (!headSha || latestCached.headSha === headSha)) {
          return latestCached.data
        }
        return []
      } finally {
        inflightChecksRequests.delete(inflightKey)
      }
    })()

    inflightChecksRequests.set(inflightKey, {
      promise: request,
      force: Boolean(options?.force),
      noCache: Boolean(options?.force || options?.noCache)
    })
    return request
  },

  fetchPRCheckDetails: async (repoPath, args, options): Promise<PRCheckRunDetails | null> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(
      get().settings,
      repo,
      options?.sourceContext
    )
    const requestContext = getGitHubWorkItemRequestContext(
      get(),
      requestSettings,
      repoId ?? repoPath,
      repoPath,
      options?.sourceContext
    )
    const requestTarget = requestContext.target
    return requestTarget.kind === 'environment'
      ? await withGitHubCheckDetailsTimeout((signal) =>
          callRuntimeRpc<PRCheckRunDetails | null>(
            { kind: 'environment', environmentId: requestTarget.environmentId },
            'github.prCheckDetails',
            {
              repo: requestTarget.runtimeRepoId,
              checkRunId: args.checkRunId,
              workflowRunId: args.workflowRunId,
              checkName: args.checkName,
              url: args.url,
              prRepo: args.prRepo ?? null
            },
            { timeoutMs: 30_000, signal }
          )
        )
      : await withGitHubCheckDetailsTimeout(() =>
          window.api.gh.prCheckDetails({
            repoPath,
            repoId,
            checkRunId: args.checkRunId,
            workflowRunId: args.workflowRunId,
            checkName: args.checkName,
            url: args.url,
            prRepo: args.prRepo ?? null,
            sourceContext: options?.sourceContext
          })
        )
  }
})
