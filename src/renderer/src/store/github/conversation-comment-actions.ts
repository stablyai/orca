import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubCommentResult } from '../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { withBoundedCacheEntry } from './cache-policy'
import { hasUsableCommentPayload, mergePRCommentIntoList } from './pr-comment-cache'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'

export const createConversationCommentActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'addPRConversationComment'> => ({
  addPRConversationComment: async (repoPath, prNumber, body, options) => {
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
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )
    const requestContext = getGitHubWorkItemRequestContext(
      get(),
      requestSettings,
      repoId ?? repoPath,
      repoPath,
      options?.sourceContext
    )
    let result: GitHubCommentResult
    try {
      result =
        requestContext.target.kind === 'environment'
          ? await callRuntimeRpc<GitHubCommentResult>(
              { kind: 'environment', environmentId: requestContext.target.environmentId },
              'github.addIssueComment',
              {
                repo: requestContext.target.runtimeRepoId,
                number: prNumber,
                body,
                type: 'pr',
                prRepo: options?.prRepo ?? null
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.addIssueComment({
              repoPath,
              repoId,
              number: prNumber,
              body,
              type: 'pr',
              prRepo: options?.prRepo ?? null,
              sourceContext: options?.sourceContext
            })
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to post comment.'
      return { ok: false, error }
    }
    if (!hasUsableCommentPayload(result)) {
      return result.ok
        ? {
            ok: false,
            error: translate(
              'auto.store.slices.github.f129c42773',
              'GitHub did not return the new comment.'
            )
          }
        : result
    }
    set((s) => {
      const entry = s.commentsCache[cacheKey]
      return {
        commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
          data: mergePRCommentIntoList(entry?.data, result.comment),
          fetchedAt: Date.now()
        })
      }
    })
    return result
  }
})
