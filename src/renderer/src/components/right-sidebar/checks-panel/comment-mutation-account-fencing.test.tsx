// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitHubCommentResult, PRComment } from '../../../../../shared/github/comment-types'
import { getDefaultSettings } from '../../../../../shared/constants'
import { repoCacheEviction } from '@/store/github/cache-identity'
import { clearInflightGitHubRequestsForRepo } from '@/store/github/request-coordination'
import { useChecksPanelCommentMutations } from './use-checks-panel-comment-mutations'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import type { GitHubProjectMutationResult } from '../../../../../shared/github/project-result-types'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: true })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))

const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
const pr = {
  number: 1,
  title: 'Review',
  state: 'open' as const,
  url: '',
  checksStatus: 'pending' as const,
  updatedAt: '',
  mergeable: 'MERGEABLE' as const,
  prRepo: { owner: 'org', repo: 'repo', host: 'github.com' }
}
const alice: PRComment = {
  id: 1,
  author: 'alice',
  authorAvatarUrl: '',
  body: 'Alice comment',
  createdAt: '',
  url: '',
  threadId: 'thread-1',
  path: 'file.ts',
  line: 1,
  reactionSubjectId: 'comment-1',
  isResolved: false,
  reactions: [{ content: '+1', count: 1, viewerHasReacted: true }]
}
const bob = { ...alice, author: 'bob', body: 'Bob comment', isResolved: true, reactions: [] }
const conversation = { ...alice, threadId: undefined, path: undefined }
const evict = () =>
  clearInflightGitHubRequestsForRepo(repoCacheEviction([repo], repo.id, repo.path, 'local'))
const initialApi = window.api

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: initialApi })
})

it.each(['conversation', 'reply', 'reaction', 'settled conversation'] as const)(
  'does not restore old-account %s state after the same review reloads',
  async (kind) => {
    const receipt = Promise.withResolvers<GitHubCommentResult>()
    const reaction = Promise.withResolvers<boolean>()
    const { result } = renderHook(() => {
      const [comments, setComments] = useState<PRComment[]>([alice])
      const actions = useChecksPanelCommentMutations({
        repo,
        pr,
        prNumber: 1,
        prCacheKey: 'repo-1::main',
        branch: 'main',
        commentsRef: { current: comments },
        setComments,
        isCurrentAsyncResult: () => true,
        commentsDisabledReason: undefined,
        confirm: vi.fn(),
        addPRConversationComment: () => receipt.promise,
        addPRReviewCommentReply: () => receipt.promise,
        setPRCommentReaction: () => reaction.promise
      })
      return { ...actions, comments, setComments }
    })
    let pending: Promise<unknown> | undefined
    act(() => {
      pending =
        kind === 'conversation' || kind === 'settled conversation'
          ? result.current.handleAddPRComment('Hello')
          : kind === 'reply'
            ? result.current.handleReplyToComment(alice, 'Hello')
            : result.current.handleSetReaction(alice, '+1', false)
    })
    if (kind === 'settled conversation') {
      void receipt.promise.then(() =>
        queueMicrotask(() => {
          evict()
          result.current.setComments([bob])
        })
      )
    } else {
      act(() => {
        evict()
        result.current.setComments([bob])
      })
    }
    await act(async () => {
      receipt.resolve({ ok: true, comment: { ...alice, id: 2 } })
      reaction.resolve(false)
      await pending
    })
    expect(result.current.comments).toEqual([bob])
  }
)

it('does not restore an old thread snapshot into the same review under a new account', async () => {
  const pending = Promise.withResolvers<boolean>()
  const { result } = renderHook(() => {
    const [comments, setComments] = useState<PRComment[]>([alice])
    const actions = useChecksPanelCommentResolution({
      repo,
      pr,
      prNumber: 1,
      prCacheKey: 'repo-1::main',
      branch: 'main',
      activeGitLabReview: null,
      activeReview: null,
      activeWorktree: null,
      activeWorktreeId: null,
      claimedCommentResolutionRef: { current: null },
      pendingCommentResolutionRef: { current: null },
      commentResolutionLaunchAcceptedRef: { current: false },
      commentResolutionAckBusy: false,
      commentsLoading: false,
      detectedAgentIds: null,
      isCurrentAsyncResult: () => true,
      resolveReviewThread: () => pending.promise,
      setComments,
      setAgentComposerState: vi.fn(),
      settings: getDefaultSettings('/tmp/comment-fence'),
      sourceControlAiActionsVisible: false
    })
    return { ...actions, comments, setComments }
  })
  let mutation: Promise<boolean> | undefined
  act(() => {
    mutation = result.current.handleResolve('thread-1', true)
  })
  act(() => {
    evict()
    result.current.setComments([bob])
  })
  await act(async () => {
    pending.resolve(false)
    await mutation
  })
  expect(result.current.comments).toEqual([bob])
})

it.each(['edit', 'delete'] as const)(
  'ignores an old-account %s result in the same review',
  async (kind) => {
    const receipt = Promise.withResolvers<GitHubProjectMutationResult>()
    const request = vi.fn(() => receipt.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gh: { updateIssueCommentBySlug: request, deleteIssueCommentBySlug: request }
      }
    })
    const { result } = renderHook(() => {
      const [comments, setComments] = useState<PRComment[]>([conversation])
      const actions = useChecksPanelCommentMutations({
        repo,
        pr,
        prNumber: 1,
        prCacheKey: 'repo-1::main',
        branch: 'main',
        commentsRef: { current: comments },
        setComments,
        isCurrentAsyncResult: () => true,
        commentsDisabledReason: undefined,
        confirm: vi.fn(async () => true),
        addPRConversationComment: vi.fn(),
        addPRReviewCommentReply: vi.fn(),
        setPRCommentReaction: vi.fn()
      })
      return { ...actions, comments, setComments }
    })
    let mutation: Promise<unknown> | undefined
    await act(async () => {
      mutation =
        kind === 'edit'
          ? result.current.handleEditComment(conversation, 'Edited by Alice')
          : result.current.handleDeleteComment(conversation)
    })
    expect(request).toHaveBeenCalledOnce()
    act(() => {
      evict()
      result.current.setComments([bob])
    })
    await act(async () => {
      receipt.resolve({ ok: true })
      await mutation
    })
    expect(result.current.comments).toEqual([bob])
  }
)

it('keeps an AI acknowledgement receipt out of the next account comments', async () => {
  const receipt = Promise.withResolvers<GitHubCommentResult>()
  const { result } = renderHook(() => {
    const [comments, setComments] = useState<PRComment[]>([conversation])
    const actions = useChecksPanelAiAcknowledgement({
      addPRConversationComment: () => receipt.promise,
      addPRReviewCommentReply: vi.fn(),
      asyncResultKeyRef: { current: 'repo-1::main::1::head' },
      claimedCommentResolutionRef: { current: null },
      commentsRef: { current: comments },
      commentsSelectionClearTokenRef: { current: 0 },
      pendingCommentResolutionRef: { current: null },
      resolveReviewThread: vi.fn(),
      setCommentResolutionAckBusyNow: vi.fn(),
      setComments,
      setCommentsSelectionClearRequest: vi.fn(),
      commentResolutionLaunchAcceptedRef: { current: false },
      fetchComments: vi.fn(),
      fetchGitLabDetails: vi.fn()
    })
    return { ...actions, comments, setComments }
  })
  let mutation: Promise<unknown> | undefined
  act(() => {
    mutation = result.current.resolveSelectedThreadsAfterLaunch({
      reviewContextKey: 'repo-1::main::1::head',
      provider: 'github',
      selectedGroups: [{ kind: 'standalone', comment: conversation }],
      githubTarget: { repoPath: '/repo', repoId: 'repo-1', prNumber: 1, prRepo: pr.prRepo }
    })
  })
  act(() => {
    evict()
    result.current.setComments([bob])
  })
  await act(async () => {
    receipt.resolve({ ok: true, comment: { ...conversation, id: 2 } })
    await mutation
  })
  expect(result.current.comments).toEqual([bob])
})
