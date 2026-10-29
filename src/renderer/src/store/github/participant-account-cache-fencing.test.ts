import { beforeEach, expect, it, vi } from 'vitest'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import type { GitHubCommentResult, PRComment } from '../../../../shared/github/comment-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

const aliceComment: PRComment = {
  id: 1,
  author: 'alice',
  authorAvatarUrl: '',
  body: 'Alice account comment',
  createdAt: '',
  url: 'https://github.com/org/repo/pull/1#comment-1',
  threadId: 'thread-1',
  reactionSubjectId: 'comment-1',
  isResolved: false,
  reactions: [{ content: '+1', count: 1, viewerHasReacted: true }]
}

it.each(['conversation', 'review reply'] as const)(
  'preserves a pending %s receipt without caching its previous-account comment',
  async (kind) => {
    const store = createTestStore()
    store.setState({ repos: [] })
    const pending = Promise.withResolvers<GitHubCommentResult>()
    const api =
      kind === 'conversation' ? mockApi.gh.addIssueComment : mockApi.gh.addPRReviewCommentReply
    api.mockReturnValueOnce(pending.promise)
    const mutation =
      kind === 'conversation'
        ? store.getState().addPRConversationComment('/repo', 1, 'Hello', { repoId: 'repo-1' })
        : store.getState().addPRReviewCommentReply('/repo', 1, 1, 'Hello', { repoId: 'repo-1' })
    store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
    pending.resolve({ ok: true, comment: aliceComment })
    await expect(mutation).resolves.toMatchObject({ ok: true, comment: aliceComment })
    expect(store.getState().commentsCache).toEqual({})
  }
)

it.each(['thread', 'reaction'] as const)(
  'does not roll back a pending %s mutation into the next account cache',
  async (kind) => {
    const store = createTestStore()
    store.setState({ repos: [] })
    mockApi.gh.prComments.mockResolvedValueOnce([aliceComment])
    await store.getState().fetchPRComments('/repo', 1, { repoId: 'repo-1' })
    const pending = Promise.withResolvers<boolean>()
    const api = kind === 'thread' ? mockApi.gh.resolveReviewThread : mockApi.gh.setPRCommentReaction
    api.mockReturnValueOnce(pending.promise)
    const mutation =
      kind === 'thread'
        ? store.getState().resolveReviewThread('/repo', 1, 'thread-1', true, { repoId: 'repo-1' })
        : store
            .getState()
            .setPRCommentReaction('/repo', 1, 'comment-1', '+1', false, { repoId: 'repo-1' })
    store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
    const bobComment = {
      ...aliceComment,
      author: 'bob',
      body: 'Bob account comment',
      isResolved: true,
      reactions: []
    }
    mockApi.gh.prComments.mockResolvedValueOnce([bobComment])
    await store.getState().fetchPRComments('/repo', 1, { repoId: 'repo-1' })
    const bobCache = store.getState().commentsCache
    pending.resolve(false)
    await expect(mutation).resolves.toBe(false)
    expect(store.getState().commentsCache).toEqual(bobCache)
  }
)

it('keeps concurrent mutation cache writes through unrelated repository and host evictions', async () => {
  const store = createTestStore()
  const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
  store.setState({ repos: [repo, { ...repo, executionHostId: 'runtime:server' }] })
  const first = Promise.withResolvers<GitHubCommentResult>()
  const second = Promise.withResolvers<GitHubCommentResult>()
  mockApi.gh.addIssueComment.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const mutations = [
    store.getState().addPRConversationComment('/repo', 1, 'First', { repoId: 'repo-1' }),
    store.getState().addPRConversationComment('/repo', 1, 'Second', { repoId: 'repo-1' })
  ]
  store.getState().evictGitHubRepoCaches('other-repo', '/other', 'local')
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'runtime:server')
  first.resolve({ ok: true, comment: aliceComment })
  second.resolve({ ok: true, comment: { ...aliceComment, id: 2, body: 'Second comment' } })
  await Promise.all(mutations)
  expect(Object.values(store.getState().commentsCache)[0]?.data).toEqual([
    aliceComment,
    { ...aliceComment, id: 2, body: 'Second comment' }
  ])
})

it('keeps a new mutation fenced after an evicted predecessor finishes', async () => {
  const store = createTestStore()
  store.setState({ repos: [] })
  const old = Promise.withResolvers<GitHubCommentResult>()
  const current = Promise.withResolvers<GitHubCommentResult>()
  mockApi.gh.addIssueComment.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const first = store.getState().addPRConversationComment('/repo', 1, 'First', { repoId: 'repo-1' })
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
  const second = store
    .getState()
    .addPRConversationComment('/repo', 1, 'Second', { repoId: 'repo-1' })
  old.resolve({ ok: true, comment: aliceComment })
  await first
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
  current.resolve({ ok: true, comment: aliceComment })
  await second
  expect(store.getState().commentsCache).toEqual({})
})

it('returns transport errors and releases the mutation cache fence', async () => {
  const store = createTestStore()
  store.setState({ repos: [] })
  mockApi.gh.addIssueComment.mockRejectedValueOnce(new Error('Connection lost'))
  await expect(
    store.getState().addPRConversationComment('/repo', 1, 'Hello', { repoId: 'repo-1' })
  ).resolves.toEqual({ ok: false, error: 'Connection lost' })
  expect(store.getState().commentsCache).toEqual({})
})
it('drops pending issue and comment results after account eviction without deleting newer requests', async () => {
  const store = createTestStore()
  store.setState({ repos: [] })
  const oldIssue = Promise.withResolvers<IssueInfo | null>()
  const newIssue = Promise.withResolvers<IssueInfo | null>()
  const oldComments = Promise.withResolvers<PRComment[]>()
  const newComments = Promise.withResolvers<PRComment[]>()
  mockApi.gh.issue.mockReturnValueOnce(oldIssue.promise).mockReturnValueOnce(newIssue.promise)
  mockApi.gh.prComments
    .mockReturnValueOnce(oldComments.promise)
    .mockReturnValueOnce(newComments.promise)
  const firstIssue = store.getState().fetchIssue('/repo', 1, { repoId: 'repo-1' })
  const firstComments = store.getState().fetchPRComments('/repo', 1, { repoId: 'repo-1' })
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
  const secondIssue = store.getState().fetchIssue('/repo', 1, { repoId: 'repo-1' })
  const secondComments = store.getState().fetchPRComments('/repo', 1, { repoId: 'repo-1' })
  oldIssue.resolve(null)
  oldComments.resolve([])
  await Promise.all([firstIssue, firstComments])
  expect(store.getState().issueCache).toEqual({})
  expect(store.getState().commentsCache).toEqual({})
  const thirdIssue = store.getState().fetchIssue('/repo', 1, { repoId: 'repo-1' })
  const thirdComments = store.getState().fetchPRComments('/repo', 1, { repoId: 'repo-1' })
  expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
  expect(mockApi.gh.prComments).toHaveBeenCalledTimes(2)
  newIssue.resolve(null)
  newComments.resolve([])
  await Promise.all([secondIssue, secondComments, thirdIssue, thirdComments])
})
it('drops pending PR and check cache writes after account eviction', async () => {
  const store = createTestStore()
  store.setState({ repos: [] })
  const oldPR = Promise.withResolvers<PRRefreshOutcome>()
  const oldChecks = Promise.withResolvers<PRCheckDetail[]>()
  mockApi.gh.refreshPRNow.mockReturnValueOnce(oldPR.promise)
  mockApi.gh.prChecks.mockReturnValueOnce(oldChecks.promise)
  const pr = store.getState().fetchPRForBranch('/repo', 'main', { repoId: 'repo-1' })
  const checks = store
    .getState()
    .fetchPRChecks('/repo', 1, 'main', undefined, undefined, { repoId: 'repo-1' })
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
  oldPR.resolve({ kind: 'found', pr: makePR(), fetchedAt: 1_800_000_000_000 })
  oldChecks.resolve([])
  await Promise.all([pr, checks])
  expect(store.getState().prCache).toEqual({})
  expect(store.getState().checksCache).toEqual({})
  expect(store.getState().hostedReviewCache).toEqual({})
})
it('evicts GitHub-derived hosted reviews and fences pending generic review lookups', async () => {
  const store = createTestStore()
  store.setState({ repos: [] })
  const review = {
    provider: 'github' as const,
    number: 1,
    title: 'Private review',
    state: 'open' as const,
    url: 'https://github.com/org/repo/pull/1',
    status: 'success' as const,
    updatedAt: '',
    mergeable: 'MERGEABLE' as const
  }
  mockApi.hostedReview.forBranch.mockResolvedValueOnce(review)
  await store.getState().fetchHostedReviewForBranch('/repo', 'main', { repoId: 'repo-1' })
  expect(Object.keys(store.getState().hostedReviewCache)).toHaveLength(1)
  const pending = Promise.withResolvers<typeof review>()
  mockApi.hostedReview.forBranch.mockReturnValueOnce(pending.promise)
  const refresh = store
    .getState()
    .fetchHostedReviewForBranch('/repo', 'main', { repoId: 'repo-1', force: true })
  store.getState().evictGitHubRepoCaches('repo-1', '/repo', 'local')
  expect(store.getState().hostedReviewCache).toEqual({})
  pending.resolve(review)
  await refresh
  expect(store.getState().hostedReviewCache).toEqual({})
})
