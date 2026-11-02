import { beforeEach, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

const repoPath = '/repo'
const repoId = 'thread-rollback-repo'
const threadId = 'thread-10'
const options = { repoId, prRepo: { owner: 'Acme', repo: 'Widgets' } }
const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
const original: PRComment = {
  id: 10,
  reactionSubjectId: 'IC_10',
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Before',
  threadId,
  isResolved: false,
  createdAt: '2026-10-28T00:00:00Z',
  url: ''
}
const reply: PRComment = { ...original, id: 11, body: 'Posted reply' }

function makeStore(comments = [original]) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: repoId, path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    commentsCache: { [cacheKey]: { data: comments, fetchedAt: 1 } }
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.addPRReviewCommentReply.mockResolvedValue({ ok: true, comment: reply })
})

it('keeps a reply posted while a failed unresolve was pending, with the thread state restored', async () => {
  const resolved = { ...original, isResolved: true }
  const store = makeStore([resolved])
  const result = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, false, options)
  expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(false)
  const restReply = { ...reply }
  delete restReply.isResolved
  mockApi.gh.addPRReviewCommentReply.mockResolvedValueOnce({ ok: true, comment: restReply })
  await expect(
    store.getState().addPRReviewCommentReply(repoPath, 12, 10, reply.body, { ...options, threadId })
  ).resolves.toMatchObject({ ok: true })
  result.resolve(false)
  await expect(pending).resolves.toBe(false)
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([
    resolved,
    { ...restReply, isResolved: true }
  ])
})

it('ignores an opposite resolve on a thread while the first request is in flight', async () => {
  const store = makeStore()
  const first = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(first.promise)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  await expect(
    store.getState().resolveReviewThread(repoPath, 12, threadId, false, options)
  ).resolves.toBe(true)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
  first.resolve(true)
  await expect(pending).resolves.toBe(true)
})

it('releases the thread after a failed request so it can be resolved again', async () => {
  const store = makeStore()
  const first = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(first.promise)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  await store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  first.reject(new Error('socket closed'))
  await expect(pending).resolves.toBe(false)
  expect(store.getState().reviewThreadResolutionsInFlight).toEqual({})
  mockApi.gh.resolveReviewThread.mockResolvedValueOnce(true)
  await expect(
    store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  ).resolves.toBe(true)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
  expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
})
