import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import { createRuntimeRpcAbortError } from '@/runtime/abortable-runtime-environment-call'
import { normalizeCheckRunDetailsLogTails } from '@/lib/check-run-details-log-normalization'
import { translate } from '@/i18n/i18n'
import {
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE,
  isGitHubCheckDetailsTimeout
} from '../../../../shared/github/check-details-deadline'
import { syncPRChecksStatus } from '../slices/github-checks'
import { isWslDistroNotRunningRefusal } from '../../../../shared/wsl-distro-not-running-refusal'
import {
  getPRChecksCacheTtl,
  prChecksCacheSuffix,
  sourceScopedRepoCacheKey
} from './cache-identity'
import { isFresh, withBoundedCacheEntry } from './cache-policy'
import {
  inflightChecksRequests,
  nextProviderRequestId,
  ownsInflightRequest
} from './request-coordination'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext
} from './work-item-routing'

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
    const requestSettings = getGitHubRepoSourceSettings(get(), repo, options?.sourceContext)
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
    const userRefresh = options?.userRefresh === true
    const force = Boolean(options?.force) || userRefresh
    const noCache = force || Boolean(options?.noCache)
    if (
      !force &&
      !noCache &&
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
      }
      return cachedChecks
    }

    const recoverChecks = (err: unknown): PRCheckDetail[] => {
      if (options?.throwOnError) {
        throw err
      }
      // A poll refused for a stopped WSL distro is expected; the cached checks below stand.
      if (!isWslDistroNotRunningRefusal(err)) {
        console.error('Failed to fetch PR checks:', err)
      }
      const latestCached = get().checksCache[cacheKey] ?? get().checksCache[legacyCacheKey]
      return latestCached?.data && (!headSha || latestCached.headSha === headSha)
        ? latestCached.data
        : []
    }

    let waitedForUpgrade = false
    // An explicit refresh is neither answered by nor kept waiting on a read begun before it.
    while (!userRefresh) {
      const inflightRequest = inflightChecksRequests.get(inflightKey)
      if (!inflightRequest) {
        break
      }
      const weakerThanRequested =
        (force && !inflightRequest.force) ||
        (noCache && !inflightRequest.noCache) ||
        (options?.wakeWslDistro && !inflightRequest.wakeWslDistro)
      if (!weakerThanRequested) {
        return inflightRequest.promise.catch(recoverChecks)
      }
      // Wait once for weaker requests so upgrades coalesce without starvation from repeated weak callers.
      if (waitedForUpgrade) {
        break
      }
      waitedForUpgrade = true
      await inflightRequest.promise.catch(() => {})
    }

    const requestId = nextProviderRequestId()
    const requestStartedAt = Date.now()
    const replaced = inflightChecksRequests.get(inflightKey)
    let reply: Promise<PRCheckDetail[]> | undefined
    const request = (async () => {
      const requestContext = getGitHubWorkItemRequestContext(
        get(),
        getGitHubSourceTarget(get(), repo, options?.sourceContext),
        repoId ?? repoPath,
        repoPath,
        options?.sourceContext
      )
      reply =
        requestContext.target.kind === 'environment'
          ? callRuntimeRpc<PRCheckDetail[]>(
              { kind: 'environment', environmentId: requestContext.target.environmentId },
              'github.prChecks',
              {
                repo: requestContext.target.runtimeRepoId,
                prNumber,
                headSha,
                prRepo: prRepo ?? null,
                noCache,
                ...(userRefresh ? { userRefresh: true } : {})
              },
              { timeoutMs: 30_000 }
            )
          : window.api.gh.prChecks({
              repoPath,
              repoId,
              prNumber,
              headSha,
              prRepo: prRepo ?? null,
              noCache,
              sourceContext: options?.sourceContext,
              ...(userRefresh ? { userRefresh: true } : {}),
              ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
            })
      // If this read fails, the read it replaced still lands its answer, which is newer than the cache.
      const checks = await reply.catch(async (err: unknown) => {
        if (!replaced?.reply) {
          throw err
        }
        return replaced.reply.catch(() => {
          throw err
        })
      })
      // Bounded waits and explicit refreshes overlap older reads; only the current key owner may write caches/derived PR state, preserving newer run evidence.
      if (!ownsInflightRequest(inflightChecksRequests, inflightKey, requestId)) {
        // Its callers show the owner's answer, so a late superseded reply cannot repaint older checks.
        await inflightChecksRequests.get(inflightKey)?.promise.catch(() => {})
        const latest = get().checksCache[cacheKey]
        return latest?.data && latest.fetchedAt >= requestStartedAt ? latest.data : checks
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
      return checks
    })().finally(() => {
      if (ownsInflightRequest(inflightChecksRequests, inflightKey, requestId)) {
        inflightChecksRequests.delete(inflightKey)
      }
    })

    inflightChecksRequests.set(inflightKey, {
      promise: request,
      reply,
      requestId,
      force,
      noCache,
      wakeWslDistro: Boolean(options?.wakeWslDistro)
    })
    return request.catch(recoverChecks)
  },

  fetchPRCheckDetails: async (repoPath, args, options): Promise<PRCheckRunDetails | null> => {
    try {
      const repo = get().repos?.find((candidate) =>
        options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
      )
      const repoId = options?.repoId ?? repo?.id
      const requestContext = getGitHubWorkItemRequestContext(
        get(),
        getGitHubSourceTarget(get(), repo, options?.sourceContext),
        repoId ?? repoPath,
        repoPath,
        options?.sourceContext
      )
      const requestTarget = requestContext.target
      const rawDetails =
        requestTarget.kind === 'environment'
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
      return normalizeCheckRunDetailsLogTails(rawDetails)
    } catch (error) {
      const timeoutMessage = translate(
        'auto.runtime.githubCheckDetailsTimeout.timedOut',
        GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
      )
      if (
        isGitHubCheckDetailsTimeout(error) ||
        (error instanceof Error && error.message === timeoutMessage)
      ) {
        throw new Error(timeoutMessage)
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw createRuntimeRpcAbortError()
      }
      throw new Error(
        translate(
          'auto.store.slices.editor.checkRunDetailsLoadFailed',
          'Failed to load check details.'
        )
      )
    }
  }
})
