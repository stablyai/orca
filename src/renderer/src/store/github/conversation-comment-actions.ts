import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubCommentResult } from '../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import { findRepoForGitHubOwner } from './repository-routing'
import { hostedReviewOwnerIpcArgs } from '../slices/hosted-review-cache-state'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { withBoundedCacheEntry } from './cache-policy'
import { hasUsableCommentPayload, mergePRCommentIntoList } from './pr-comment-cache'
import { inflightCommentsRequests } from './request-coordination'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext
} from './work-item-routing'

export const createConversationCommentActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'addPRConversationComment'> => ({
  addPRConversationComment: async (repoPath, prNumber, body, options) => {
    try {
      const repo = findRepoForGitHubOwner(
        get(),
        options?.repoId,
        repoPath,
        options?.repoOwnerExecutionHostId
      )
      const repoId = options?.repoId ?? repo?.id
      const requestSettings = getGitHubRepoSourceSettings(get(), repo, options?.sourceContext)
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
        getGitHubSourceTarget(get(), repo, options?.sourceContext),
        repoId ?? repoPath,
        repoPath,
        options?.sourceContext
      )
      const result: GitHubCommentResult =
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
              ...hostedReviewOwnerIpcArgs(options),
              sourceContext: options?.sourceContext
            })
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
      inflightCommentsRequests.get(cacheKey)?.postedComments.push(result.comment)
      return result
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
})
