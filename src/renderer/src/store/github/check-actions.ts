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
import {
  inflightChecksRequests,
  nextProviderRequestId,
  ownsInflightRequest
} from './request-coordination'
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

    const recoverChecks = (err: unknown): PRCheckDetail[] => {
      if (options?.throwOnError) {
        throw err
      }
      console.error('Failed to fetch PR checks:', err)
      const latestCached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
      return latestCached?.data && (!headSha || latestCached.headSha === headSha)
        ? latestCached.data
        : []
    }

    let waitedForUpgrade = false
    for (;;) {
      const inflightRequest = inflightChecksRequests.get(inflightKey)
      if (!inflightRequest) {
        break
      }
      const weakerThanRequested =
        (options?.force && !inflightRequest.force) || (options?.noCache && !inflightRequest.noCache)
      if (!weakerThanRequested) {
        return inflightRequest.promise.catch(recoverChecks)
      }
      // Why: wait out one weaker request so peers can share the upgrade, but never twice — a steady stream of weaker callers would otherwise starve this one forever.
      if (waitedForUpgrade) {
        break
      }
      waitedForUpgrade = true
      await inflightRequest.promise.catch(() => {})
    }

    const requestId = nextProviderRequestId()
    const request = (async () => {
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
          : await window.api.gh.prChecks({
              repoPath,
              repoId,
              prNumber,
              headSha,
              prRepo: prRepo ?? null,
              noCache: Boolean(options?.force || options?.noCache),
              sourceContext: options?.sourceContext
            })
      // Why: the bounded upgrade wait can leave us running beside a stronger request for this
      // key. Both bypass gh's cache here, but the later-started one holds the newer run state —
      // let only the key's current owner write checksCache and the PR status it derives.
      if (!ownsInflightRequest(inflightChecksRequests, inflightKey, requestId)) {
        return checks
      }
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
    })().finally(() => {
      if (ownsInflightRequest(inflightChecksRequests, inflightKey, requestId)) {
        inflightChecksRequests.delete(inflightKey)
      }
    })

    inflightChecksRequests.set(inflightKey, {
      promise: request,
      requestId,
      force: Boolean(options?.force),
      noCache: Boolean(options?.force || options?.noCache)
    })
    return request.catch(recoverChecks)
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
