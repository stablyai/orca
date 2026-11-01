// @vitest-environment happy-dom

import { useState, type SetStateAction } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitLabDiscussionResolveResult } from '../../../../../shared/gitlab-types'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { useChecksPanelCommentMutations } from './use-checks-panel-comment-mutations'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

type Input = Omit<
  Parameters<typeof useChecksPanelCommentMutations>[0] &
    Parameters<typeof useChecksPanelCommentResolution>[0],
  'setComments'
>

const comments: PRComment[] = [
  {
    id: 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'Review comment',
    createdAt: '2026-10-01T00:00:00Z',
    url: '',
    reactionSubjectId: 'comment-node',
    reactions: [{ content: '+1', count: 2, viewerHasReacted: false }],
    threadId: 'thread-1',
    isResolved: false
  },
  {
    id: 2,
    author: 'author',
    authorAvatarUrl: '',
    body: 'Thread reply',
    createdAt: '2026-10-01T00:00:00Z',
    url: '',
    threadId: 'thread-1',
    isResolved: false
  }
]

function makeInput(overrides: Partial<Input> = {}): Input {
  const pr = {
    number: 42,
    title: 'Review',
    state: 'open' as const,
    url: 'https://github.com/acme/repo/pull/42',
    checksStatus: 'success' as const,
    updatedAt: '2026-10-01T00:00:00Z',
    mergeable: 'MERGEABLE' as const,
    headSha: 'head-sha',
    prRepo: { owner: 'acme', repo: 'repo' }
  }
  return {
    activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:workspace-host' }),
    activeWorktreeId: 'wt-1',
    repo: {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'Repo',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'workspace-host'
    },
    branch: 'feature',
    pr,
    prCacheKey: 'repo-cache',
    prNumber: 42,
    activeReview: null,
    activeGitLabReview: null,
    asyncResultKeyRef: {
      current: checksPanelAsyncResultKey('repo-cache', 'feature', 42, pr.prRepo, pr.headSha)
    },
    commentsRef: { current: comments },
    commentsDisabledReason: undefined,
    commentsLoading: false,
    confirm: vi.fn(async () => true),
    isCurrentAsyncResult: vi.fn(() => true),
    addPRConversationComment: vi.fn(),
    addPRReviewCommentReply: vi.fn(),
    setPRCommentReaction: vi.fn(async () => true),
    resolveReviewThread: vi.fn(async () => true),
    claimedCommentResolutionRef: { current: null },
    pendingCommentResolutionRef: { current: null },
    commentResolutionLaunchAcceptedRef: { current: false },
    commentResolutionAckBusy: false,
    detectedAgentIds: null,
    setAgentComposerState: vi.fn(),
    settings: null,
    sourceControlAiActionsVisible: false,
    ...overrides
  }
}

function renderActions(input: Input) {
  const updates: SetStateAction<PRComment[]>[] = []
  return {
    updates,
    ...renderHook(() => {
      const [currentComments, setCurrentComments] = useState(comments)
      const model = {
        ...input,
        setComments: (next: SetStateAction<PRComment[]>) => {
          updates.push(next)
          setCurrentComments(next)
        }
      }
      return {
        comments: currentComments,
        ...useChecksPanelCommentMutations(model),
        ...useChecksPanelCommentResolution(model)
      }
    })
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('comment action ownership refusal', () => {
  it('returns a failure for a new comment without posting or changing comments', async () => {
    const input = makeInput({
      activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:other-host' })
    })
    const { result, updates } = renderActions(input)

    await act(async () => {
      await expect(result.current.handleAddPRComment('New comment')).resolves.toEqual({
        ok: false,
        error: 'The repository does not match this workspace’s owning host.'
      })
    })

    expect(result.current.comments).toEqual(comments)
    expect(updates).toHaveLength(0)
    expect(input.addPRConversationComment).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      'The repository does not match this workspace’s owning host.'
    )
  })

  it.each(['review', 'conversation'] as const)(
    'returns a failure for a %s reply, honoring notification options',
    async (kind) => {
      const input = makeInput({
        activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:other-host' })
      })
      const { result, updates } = renderActions(input)
      const parent = kind === 'review' ? comments[0] : { ...comments[0], threadId: undefined }
      const failure = {
        ok: false,
        error: 'The repository does not match this workspace’s owning host.'
      }

      await act(async () => {
        await expect(result.current.handleReplyToComment(parent, 'Reply')).resolves.toEqual(failure)
      })
      expect(toastError).toHaveBeenCalledWith(failure.error)

      toastError.mockClear()
      await act(async () => {
        await expect(
          result.current.handleReplyToComment(parent, 'Reply', { notifyOnFailure: false })
        ).resolves.toEqual(failure)
      })

      expect(toastError).not.toHaveBeenCalled()
      expect(input.addPRReviewCommentReply).not.toHaveBeenCalled()
      expect(input.addPRConversationComment).not.toHaveBeenCalled()
      expect(result.current.comments).toEqual(comments)
      expect(updates).toHaveLength(0)
    }
  )

  it('refuses a reaction before changing comments and reports failure', async () => {
    const input = makeInput({
      activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:other-host' })
    })
    const { result, updates } = renderActions(input)

    await act(async () => {
      expect(await result.current.handleSetReaction(comments[0], '+1', true)).toBe(false)
    })

    expect(result.current.comments).toEqual(comments)
    expect(updates).toHaveLength(0)
    expect(input.setPRCommentReaction).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledOnce()
  })

  it.each(['github', 'gitlab'] as const)(
    'refuses %s thread resolution before changing comments, honoring notification options',
    async (provider) => {
      const resolveMRDiscussion = vi.fn()
      vi.stubGlobal('api', { gl: { resolveMRDiscussion } })
      const input = makeInput({
        activeWorktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'ssh:other-host' }),
        activeGitLabReview:
          provider === 'gitlab'
            ? {
                provider: 'gitlab',
                number: 42,
                title: 'MR',
                state: 'open',
                url: 'https://gitlab.com/acme/repo/-/merge_requests/42',
                status: 'success',
                updatedAt: '2026-10-01T00:00:00Z',
                mergeable: 'MERGEABLE'
              }
            : null
      })
      const { result, updates } = renderActions(input)

      await act(async () => {
        expect(await result.current.handleResolve('thread-1', true)).toBe(false)
      })

      expect(result.current.comments).toEqual(comments)
      expect(updates).toHaveLength(0)
      expect(input.resolveReviewThread).not.toHaveBeenCalled()
      expect(resolveMRDiscussion).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledOnce()

      toastError.mockClear()
      await act(async () => {
        expect(
          await result.current.handleResolve('thread-1', true, { notifyOnFailure: false })
        ).toBe(false)
      })
      expect(toastError).not.toHaveBeenCalled()
      expect(updates).toHaveLength(0)
    }
  )
})

describe('comment action provider failures', () => {
  it.each(['refused', 'threw', 'succeeded'] as const)(
    'keeps reactions optimistic and handles a provider that %s',
    async (outcome) => {
      const pending = Promise.withResolvers<boolean>()
      const input = makeInput({ setPRCommentReaction: vi.fn(() => pending.promise) })
      const { result } = renderActions(input)
      let action: Promise<boolean> | undefined
      act(() => {
        action = result.current.handleSetReaction(comments[0], '+1', true)
      })

      expect(result.current.comments[0].reactions).toEqual([
        { content: '+1', count: 3, viewerHasReacted: true }
      ])
      expect(input.setPRCommentReaction).toHaveBeenCalledWith(
        '/workspace/repo',
        42,
        'comment-node',
        '+1',
        true,
        expect.objectContaining({ repoOwnerExecutionHostId: 'ssh:workspace-host' })
      )

      await act(async () => {
        if (outcome === 'threw') {
          pending.reject(new Error('Provider unavailable'))
        } else {
          pending.resolve(outcome === 'succeeded')
        }
        expect(await action).toBe(outcome === 'succeeded')
      })

      if (outcome === 'succeeded') {
        expect(result.current.comments[0].reactions?.[0].viewerHasReacted).toBe(true)
        expect(toastError).not.toHaveBeenCalled()
      } else {
        expect(result.current.comments).toEqual(comments)
        expect(toastError).toHaveBeenCalledOnce()
      }
    }
  )

  it.each(['github', 'gitlab'] as const)(
    'rolls back %s thread resolution when the provider refuses it',
    async (provider) => {
      const github = Promise.withResolvers<boolean>()
      const gitlab = Promise.withResolvers<GitLabDiscussionResolveResult>()
      const resolveMRDiscussion = vi.fn(() => gitlab.promise)
      vi.stubGlobal('api', { gl: { resolveMRDiscussion } })
      const input = makeInput({
        resolveReviewThread: vi.fn(() => github.promise),
        activeGitLabReview:
          provider === 'gitlab'
            ? {
                provider: 'gitlab',
                number: 42,
                title: 'MR',
                state: 'open',
                url: 'https://gitlab.com/acme/repo/-/merge_requests/42',
                status: 'success',
                updatedAt: '2026-10-01T00:00:00Z',
                mergeable: 'MERGEABLE'
              }
            : null
      })
      const { result } = renderActions(input)
      let action: Promise<boolean> | undefined
      act(() => {
        action = result.current.handleResolve('thread-1', true)
      })
      expect(result.current.comments.every((comment) => comment.isResolved)).toBe(true)

      await act(async () => {
        if (provider === 'github') {
          github.resolve(false)
        } else {
          gitlab.resolve({ ok: false, error: 'Provider unavailable' })
        }
        expect(await action).toBe(false)
      })

      expect(result.current.comments).toEqual(comments)
      expect(toastError).toHaveBeenCalledOnce()
    }
  )
})
