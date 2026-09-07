import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubCommentResult, PRComment } from '../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { restoreReactionOnSubject, setReactionOnSubject } from '@/lib/pr-comment-reactions'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { withBoundedCacheEntry } from './cache-policy'
import { hasUsableCommentPayload, mergePRCommentIntoList } from './pr-comment-cache'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'

export const createCommentMutationActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'addPRReviewCommentReply' | 'setPRCommentReaction'> => ({
  addPRReviewCommentReply: async (repoPath, prNumber, commentId, body, options) => {
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
              'github.addPRReviewCommentReply',
              {
                repo: requestContext.target.runtimeRepoId,
                prNumber,
                commentId,
                body,
                threadId: options?.threadId,
                path: options?.path,
                line: options?.line,
                prRepo: options?.prRepo ?? null
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.addPRReviewCommentReply({
              repoPath,
              repoId,
              prNumber,
              commentId,
              body,
              threadId: options?.threadId,
              path: options?.path,
              line: options?.line,
              prRepo: options?.prRepo ?? null,
              sourceContext: options?.sourceContext
            })
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to post reply.'
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
    const comment: PRComment = {
      ...result.comment,
      threadId: result.comment.threadId ?? options?.threadId,
      path: result.comment.path ?? options?.path,
      line: result.comment.line ?? options?.line
    }
    set((s) => {
      const entry = s.commentsCache[cacheKey]
      return {
        commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
          data: mergePRCommentIntoList(entry?.data, comment),
          fetchedAt: Date.now()
        })
      }
    })
    return { ok: true, comment }
  },

  setPRCommentReaction: async (
    repoPath,
    prNumber,
    reactionSubjectId,
    content,
    reacted,
    options
  ) => {
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
    const previousComment = get().commentsCache[cacheKey]?.data?.find(
      (comment) => comment.reactionSubjectId === reactionSubjectId
    )
    const previousReaction = previousComment?.reactions?.find(
      (reaction) => reaction.content === content
    )
    set((state) => {
      const entry = state.commentsCache[cacheKey]
      if (!entry?.data) {
        return state
      }
      return {
        commentsCache: {
          ...state.commentsCache,
          [cacheKey]: {
            ...entry,
            data: setReactionOnSubject(entry.data, reactionSubjectId, content, reacted)
          }
        }
      }
    })

    const requestContext = getGitHubWorkItemRequestContext(
      get(),
      requestSettings,
      repoId ?? repoPath,
      repoPath,
      options?.sourceContext
    )
    let ok = false
    try {
      ok =
        requestContext.target.kind === 'environment'
          ? await callRuntimeRpc<boolean>(
              { kind: 'environment', environmentId: requestContext.target.environmentId },
              'github.setPRCommentReaction',
              {
                repo: requestContext.target.runtimeRepoId,
                reactionSubjectId,
                content,
                reacted,
                prRepo: options?.prRepo ?? null
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.setPRCommentReaction({
              repoPath,
              repoId,
              reactionSubjectId,
              content,
              reacted,
              prRepo: options?.prRepo ?? null,
              sourceContext: options?.sourceContext
            })
    } catch (err) {
      console.error('Failed to update PR comment reaction:', err)
    }
    if (!ok && previousComment) {
      set((state) => {
        const entry = state.commentsCache[cacheKey]
        if (!entry?.data) {
          return state
        }
        return {
          commentsCache: {
            ...state.commentsCache,
            [cacheKey]: {
              ...entry,
              data: restoreReactionOnSubject(
                entry.data,
                reactionSubjectId,
                content,
                previousReaction
              )
            }
          }
        }
      })
    }
    return ok
  }
})
