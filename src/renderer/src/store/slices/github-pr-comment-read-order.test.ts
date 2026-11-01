import { beforeEach, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

const repoPath = '/repo'
const repoId = 'comment-race-repo'
const prRepo = { owner: 'Acme', repo: 'Widgets' }
const options = { repoId, prRepo }
const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
const original: PRComment = {
  id: 10,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Before',
  createdAt: '2026-10-28T00:00:00Z',
  url: ''
}
const posted: PRComment = {
  ...original,
  id: 11,
  reactionSubjectId: 'IC_11',
  body: 'Posted reply',
  createdAt: '2026-10-28T00:01:00Z'
}
const remoteAdded: PRComment = {
  ...original,
  id: 12,
  body: 'Another reviewer posted this',
  createdAt: '2026-10-28T00:00:30Z'
}

function makeStore(cached = true) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: repoId, path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    commentsCache: cached ? { [cacheKey]: { data: [original], fetchedAt: 1 } } : {}
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.addIssueComment.mockResolvedValue({ ok: true, comment: posted })
  mockApi.gh.addPRReviewCommentReply.mockResolvedValue({ ok: true, comment: posted })
})

it.each([
  ['comment', true],
  ['comment', false],
  ['reply', true],
  ['reply', false]
] as const)('merges a posted %s with complete history with cached=%s', async (kind, cached) => {
  const store = makeStore(cached)
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  const result =
    kind === 'comment'
      ? await store.getState().addPRConversationComment(repoPath, 12, posted.body, options)
      : await store.getState().addPRReviewCommentReply(repoPath, 12, 10, posted.body, options)
  expect(result.ok).toBe(true)
  const published = store.getState().commentsCache[cacheKey]
  expect(published?.data?.map(({ id }) => id)).toEqual(cached ? [10, 11] : [11])
  oldRead.resolve([original, remoteAdded])
  await expect(reading).resolves.toEqual([original, remoteAdded, posted])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original, remoteAdded, posted])
})

it('keeps a successful reaction on a newly posted reply while adding fetched history', async () => {
  const store = makeStore(false)
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  mockApi.gh.setPRCommentReaction.mockResolvedValueOnce(true)
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  await store.getState().addPRReviewCommentReply(repoPath, 12, 10, posted.body, options)
  await store.getState().setPRCommentReaction(repoPath, 12, 'IC_11', 'heart', true, options)
  oldRead.resolve([original, remoteAdded])
  const displayed = await reading
  expect(displayed.map(({ id }) => id)).toEqual([10, 12, 11])
  expect(displayed.find(({ id }) => id === posted.id)?.reactions).toEqual([
    { content: 'heart', count: 1, viewerHasReacted: true }
  ])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual(displayed)
})
